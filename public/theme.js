(()=>{
  const key='transport-theme-mode';
  const valid=value=>['system','light','dark'].includes(value)?value:'system';
  const read=()=>{try{return valid(localStorage.getItem(key)||'system')}catch{return 'system'}};
  const apply=value=>{const mode=valid(value);document.documentElement.dataset.theme=mode;document.querySelectorAll('#theme-mode').forEach(select=>{if(select.value!==mode)select.value=mode});const dark=mode==='dark'||(mode==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#101820':'#f3f6f9');return mode};
  const setMode=value=>{const mode=valid(value);try{localStorage.setItem(key,mode)}catch{}return apply(mode)};
  window.TransportTheme={getMode:read,setMode};
  apply(read());
  document.addEventListener('change',event=>{if(event.target?.matches('#theme-mode'))setMode(event.target.value)});
  window.addEventListener('storage',event=>{if(event.key===key)apply(valid(event.newValue))});
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(read()==='system')apply('system')});
})();
