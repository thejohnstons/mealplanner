// Johnston's Meal Planner: Firebase data layer
// Cloud Firestore keeps a full copy of the data in this browser (IndexedDB),
// so the app loads from the device first, keeps working offline, and syncs
// changes to every signed-in device in real time when online.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut as fbSignOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, setDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where, writeBatch }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const cfg = window.FIREBASE_CONFIG || {};
const HOUSEHOLD = window.HOUSEHOLD_ID || 'johnston';

if(!cfg.apiKey || String(cfg.apiKey).includes('PASTE')){
  onAuth({status:'noConfig'});
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  let db;
  try{
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  }catch(e){
    // Private browsing or blocked storage: still works online, just without the offline copy.
    db = initializeFirestore(app, { localCache: memoryLocalCache() });
  }

  const base = ['households', HOUSEHOLD];
  const col = name => collection(db, ...base, name);
  const ref = (name, id) => doc(db, ...base, name, id);

  let unsubs = [], planUnsub = null, checksUnsub = null;
  let planWindow = '', checksKey = '';
  const pending = {recipes:false, plan:false, checks:false};
  const reportPending = () => onSync({pending: Object.values(pending).some(Boolean)});

  function denied(err){
    if(err && err.code==='permission-denied') onAuth({status:'denied'});
    else console.warn('Firestore listener error', err);
  }
  function stopAll(){
    unsubs.forEach(u=>u()); unsubs=[];
    if(planUnsub){ planUnsub(); planUnsub=null; } if(checksUnsub){ checksUnsub(); checksUnsub=null; }
    planWindow=''; checksKey='';
  }
  function startListeners(){
    unsubs.push(onSnapshot(col('recipes'), {includeMetadataChanges:true}, snap=>{
      pending.recipes = snap.metadata.hasPendingWrites; reportPending();
      onRecipes(snap.docs.map(d=>({...d.data(), id:d.id})));
    }, denied));
  }

  // Only the dates on screen are listened to, so reads stay small as the archive grows.
  function watchWindow(weekFrom, weekTo, shopFrom, shopTo){
    const from = weekFrom < shopFrom ? weekFrom : shopFrom;
    const to = weekTo > shopTo ? weekTo : shopTo;
    const key = from+'|'+to;
    if(key !== planWindow){
      planWindow = key;
      if(planUnsub) planUnsub();
      planUnsub = onSnapshot(query(col('plan'), where('date','>=',from), where('date','<=',to)), {includeMetadataChanges:true}, snap=>{
        pending.plan = snap.metadata.hasPendingWrites; reportPending();
        const map = {}; snap.docs.forEach(d=>{ map[d.id]=d.data(); }); onPlan(map);
      }, denied);
    }
    const ck = shopFrom+'_'+shopTo;
    if(ck !== checksKey){
      checksKey = ck;
      if(checksUnsub) checksUnsub();
      checksUnsub = onSnapshot(ref('checks', ck), {includeMetadataChanges:true}, snap=>{
        pending.checks = snap.metadata.hasPendingWrites; reportPending();
        const items = (snap.exists() && snap.data().items) || {};
        const map = {}; Object.entries(items).forEach(([k,v])=>{ if(v) map[k]=true; }); onChecks(map);
      }, denied);
    }
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});

  window.DATA = {
    watchWindow,
    async signIn(){
      try{ await signInWithPopup(auth, provider); }
      catch(e){
        if(e && (e.code==='auth/popup-blocked' || e.code==='auth/operation-not-supported-in-this-environment')){
          await signInWithRedirect(auth, provider);
        } else if(e && e.code==='auth/unauthorized-domain'){
          onAuth({status:'signedOut', error:"This web address isn't approved for sign-in yet. Add it under Authentication → Settings → Authorised domains (setup guide, step 7)."});
        } else if(e && e.code!=='auth/popup-closed-by-user' && e.code!=='auth/cancelled-popup-request'){
          onAuth({status:'signedOut', error:"Sign-in didn't work ("+e.code+"). Please try again."});
        }
      }
    },
    signOut(){ return fbSignOut(auth); },
    setRecipe(r){ const {id, ...rest} = r; return setDoc(ref('recipes', id), rest); },
    deleteRecipe(id){ return deleteDoc(ref('recipes', id)); },
    setPlan(key, entry){ return setDoc(ref('plan', key), entry); },
    deletePlan(key){ return deleteDoc(ref('plan', key)); },
    setCheck(from, to, item, val){ return setDoc(ref('checks', from+'_'+to), {items:{[item]:!!val}}, {merge:true}); },
    setPhoto(id, data, recipeId){ return setDoc(ref('photos', id), {data, recipeId}); },
    deletePhoto(id){ return deleteDoc(ref('photos', id)); },
    async getPhoto(id){ const s = await getDoc(ref('photos', id)); return s.exists() ? s.data().data : null; },
    async fetchPlan(from, to){
      const s = await getDocs(query(col('plan'), where('date','>=',from), where('date','<=',to)));
      const map = {}; s.docs.forEach(d=>{ map[d.id]=d.data(); }); return map;
    },
    async exportAll(){
      const [rs, pl, ph] = await Promise.all([getDocs(col('recipes')), getDocs(col('plan')), getDocs(col('photos'))]);
      const photos = {}; ph.docs.forEach(d=>{ photos[d.id]=d.data().data; });
      return {
        recipes: rs.docs.map(d=>({...d.data(), id:d.id})),
        plan: pl.docs.map(d=>({...d.data(), key:d.id})),
        photos
      };
    },
    async importAll(recipes, plan, photos){
      const ops = [];
      recipes.forEach(r=>{ if(r && r.id){ const {id, ...rest} = r; ops.push(b=>b.set(ref('recipes', String(id)), rest)); } });
      plan.forEach(p=>ops.push(b=>b.set(ref('plan', p.key), p.entry)));
      Object.entries(photos||{}).forEach(([id,data])=>{ if(typeof data==='string' && data.length<1000000) ops.push(b=>b.set(ref('photos', id), {data})); });
      // Batches hold up to 500 writes; photos are large, so keep batches small.
      for(let i=0;i<ops.length;i+=20){
        const b = writeBatch(db); ops.slice(i,i+20).forEach(fn=>fn(b));
        const done = b.commit();
        if(navigator.onLine) await done; // offline: queued locally, syncs later
      }
    }
  };

  getRedirectResult(auth).catch(()=>{});
  onAuthStateChanged(auth, user=>{
    stopAll();
    if(!user){ onAuth({status:'signedOut', email:''}); return; }
    onAuth({status:'signedIn', email:user.email||'', error:''});
    startListeners();
    render(); // starts the plan and ticks listeners for the dates on screen
  });
}
