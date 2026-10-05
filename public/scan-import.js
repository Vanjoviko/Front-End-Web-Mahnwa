// Tab admin "Scan Import" + halaman finalisasi draft. Memakai kelas CSS dan tata letak halaman detail yang sudah ada.
const ScanImport=(()=>{
  const S={url:'',busy:false,error:'',draft:null,drafts:[],progress:null,timer:null,loaded:false,token:0};
  const WARN={PERMISSION_NOT_RECORDED:'Izin untuk sumber ini belum dicatat oleh adapter. Pastikan Anda berhak menyalin kontennya.',COVER_UNAVAILABLE:'Sampul tidak dapat diambil dari sumber; Anda dapat mengunggah sampul sendiri di halaman finalisasi.',NO_CHAPTERS:'Sumber tidak mengembalikan chapter.',TITLE_EXISTS:'Sudah ada komik dengan judul yang sama (URL sumber berbeda). Periksa sebelum publish.',SSRF_BLOCKED:'Sampul ditolak karena alamatnya tidak aman.',HOST_NOT_ALLOWED:'Host sampul tidak ada di daftar sumber yang diizinkan.'};
  const ISSUE={needs_number:'perlu nomor',ambiguous_number:'nomor ambigu',number_collision:'nomor bentrok',duplicate_number:'nomor ganda',number_required:'nomor wajib diisi',prolog:'prolog',extra:'extra/special',duplicate:'duplikat'};
  const STATE={SCANNED:'Hasil scan',DOWNLOADING:'Mengunduh',READY:'Siap ditinjau',CANCELLED:'Dibatalkan',PUBLISHED:'Dipublikasikan'};
  const CSTATUS={QUEUED:'Antre',DOWNLOADING:'Mengunduh',COMPLETED:'Selesai',FAILED:'Gagal',CANCELLED:'Dibatalkan'};
  class ApiError extends Error{constructor(message,status,data){super(message);this.status=status;this.data=data||{};this.code=data?.code;}}
  async function call(path,method='GET',body){
    const res=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    let data={};try{data=await res.json();}catch{}
    if(!res.ok)throw new ApiError(data.error||`Permintaan gagal (${res.status})`,res.status,data);
    return data;
  }
  const badge=(text,kind='')=>`<span class="badge ${kind}">${esc(text)}</span>`;
  const statusBadge=s=>s?badge(CSTATUS[s]||s,{COMPLETED:'ok',FAILED:'bad',CANCELLED:'warn',DOWNLOADING:'live',QUEUED:''}[s]||''):'';
  const issueBadges=list=>ScanFormat.visibleIssues(list).map(i=>badge(ISSUE[i]||i,'warn')).join(' ');
  const pct=(a,b)=>b>0?Math.min(100,Math.round(a*100/b)):0;
  const bar=(a,b,label='')=>`<div class="progress" role="progressbar" aria-valuenow="${pct(a,b)}" aria-valuemin="0" aria-valuemax="100" ${label?`aria-label="${esc(label)}"`:''}><span style="width:${pct(a,b)}%"></span></div>`;
  const fallbackImg="data:image/svg+xml;utf8,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="440"><rect width="100%" height="100%" fill="#202321"/><text x="50%" y="50%" fill="#777e75" font-family="sans-serif" font-size="16" text-anchor="middle">Tanpa sampul</text></svg>');

  function stop(){if(S.timer){clearInterval(S.timer);S.timer=null;}S.token++;}

  // ---------- tab Scan Import ----------
  function warningsHtml(d){const list=(d.warnings||[]).filter(w=>WARN[w]);return list.length?`<div class="scan-warnings">${list.map(w=>`<p class="warn-line">⚠ ${esc(WARN[w])}</p>`).join('')}</div>`:'';}
  function chapterRows(d){
    return d.chapters.length?`<div class="table-wrap scan-chapters"><table class="admin-table"><thead><tr><th>Chapter</th><th>Judul</th><th>Tanggal</th><th>Status sumber</th><th>Unduhan</th></tr></thead><tbody>${d.chapters.map(c=>`<tr class="${c.excluded?'row-muted':''}"><td>${c.number===null?'<i>(tanpa nomor)</i>':esc(c.number)}${c.numberRaw&&c.numberRaw!==c.number?`<br><small>${esc(c.numberRaw)}</small>`:''}</td><td>${esc(c.title||'—')}</td><td>${esc(c.date||'—')}</td><td>${c.flag==='EXISTS'?badge('SUDAH ADA',''):badge('BARU','ok')} ${issueBadges(c.issues)}</td><td>${statusBadge(c.status)||'<small>—</small>'}${c.errorMessage?`<br><small class="err-text">${esc(c.errorCode||'')} ${esc(c.errorMessage)}</small>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Tidak ada chapter pada sumber ini.</div>';
  }
  function previewHtml(d){
    const c=d.comic,downloading=d.state==='DOWNLOADING';
    const canFinalize=['READY','CANCELLED','SCANNED'].includes(d.state)&&d.counts.completed>0;
    return `<div class="admin-card scan-preview-card" data-draft="${esc(d.draftId)}">
      <div class="connector-head"><h3>Hasil scan · pratinjau</h3><span class="state ${d.state==='READY'?'siap':d.state==='DOWNLOADING'?'aktif':'nonaktif'}">${esc(STATE[d.state]||d.state)}</span></div>
      <div class="scan-preview"><img class="scan-cover" src="${esc(c.cover||fallbackImg)}" alt="Sampul ${esc(c.title)}" onerror="this.src='${fallbackImg}'">
      <div class="scan-meta"><span class="eyebrow">${esc(c.type||'Tipe belum diketahui')}${c.year?` · ${esc(c.year)}`:''}</span><h2 class="scan-title">${esc(c.title)}</h2>${c.alt?`<p class="alt">${esc(c.alt)}</p>`:''}
      <div class="detail-facts"><span class="fact">${esc(c.status||'Status belum diketahui')}</span><span class="fact">${esc(c.author||'Kreator tidak diketahui')}</span><span class="fact">Adapter: ${esc(d.adapterLabel)}</span><span class="fact">${d.counts.total} chapter</span></div>
      <p class="synopsis">${esc(c.synopsis||'Sinopsis tidak tersedia.')}</p>
      <div class="genre-cloud">${(c.genres||[]).map(x=>`<span class="genre-chip">${esc(x)}</span>`).join('')}</div>
      ${d.existingComicId?`<p class="warn-line">ℹ Komik ini sudah ada di katalog: ${d.counts.new} chapter baru, ${d.counts.exists} sudah ada. Metadata yang sudah ada tidak ditimpa.</p>`:''}
      ${warningsHtml(d)}
      <p class="scan-url"><small>Sumber: ${esc(d.canonicalUrl)}</small></p>
      <div class="hero-actions" style="margin-top:14px"><button class="btn" data-scan-action="download" ${(downloading||d.counts.total===0||d.state==='PUBLISHED')?'disabled':''}>⬇ Download All${d.counts.new?` (${d.counts.new} chapter)`:''}</button>${canFinalize?`<a class="btn ghost" href="#admin/scan/${esc(d.draftId)}">Lanjut ke finalisasi →</a>`:''}<button class="btn danger" data-scan-action="discard">Buang draft</button></div></div></div>
      <div id="scan-progress">${d.state==='DOWNLOADING'||d.job?progressHtml(S.progress,d):''}</div>
      <h4 style="margin:18px 0 8px">Daftar chapter (${d.counts.total})</h4>${chapterRows(d)}</div>`;
  }
  function progressHtml(p,d){
    if(!p)return d.state==='DOWNLOADING'?(S.pollError?`<p class="warn-line" role="alert">⚠ Gagal memuat progres: ${esc(S.pollError)}. Mencoba lagi…</p>`:'<p class="muted">Memuat progres…</p>'):'';
    const t=p.totals,dt=ScanFormat.displayTotals(p),done=t.completed+t.failed+t.cancelled;
    return `<div class="scan-progress-box"><div class="connector-head"><h4>Progres unduhan</h4>${p.state==='DOWNLOADING'?'<button class="btn danger" data-scan-action="cancel">Batalkan</button>':''}</div>
      ${S.pollError?`<p class="warn-line" role="alert">⚠ Gagal memuat progres: ${esc(S.pollError)}. Mencoba lagi…</p>`:''}
      ${p.worker&&p.worker.reachable===false?'<p class="warn-line">⚠ Layanan scan sementara tidak dapat dihubungi. Menunggu…</p>':''}
      <p class="muted">${t.completed}/${t.chapters} chapter selesai · ${t.failed} gagal · ${t.cancelled} dibatalkan · ${dt.pagesDone}${dt.pagesTotal?`/${dt.pagesTotal}`:''} halaman</p>${bar(done,t.chapters,'Progres keseluruhan')}
      <div class="progress-list">${p.chapters.map(c=>`<div class="progress-row"><span class="pr-name">Chapter ${c.number===null?'?':esc(c.number)}</span><span class="pr-bar">${bar(c.status==='COMPLETED'?1:c.pagesDone,c.status==='COMPLETED'?1:c.pagesTotal||0,'Chapter '+c.number)}</span><span class="pr-count">${ScanFormat.progressCount(c)}</span><span class="pr-status">${statusBadge(c.status)}${c.phase==='saving'?' <small>menyimpan…</small>':''}${c.attempts>1?` <small>percobaan ${c.attempts}</small>`:''}</span><span class="pr-act">${(c.status==='FAILED'||c.status==='CANCELLED')&&p.state!=='DOWNLOADING'?`<button class="btn ghost small" data-scan-retry="${esc(c.key)}">Coba lagi</button>`:''}</span>${c.errorMessage?`<span class="pr-err err-text">${esc(c.errorCode||'')} — ${esc(c.errorMessage)}</span>`:''}</div>`).join('')}</div>
      ${p.state!=='DOWNLOADING'&&t.failed+t.cancelled>0?`<div class="hero-actions" style="margin-top:12px"><button class="btn" data-scan-action="retry-failed">${ScanFormat.RETRY_ALL_LABEL}</button></div>`:''}</div>`;
  }
  function draftListHtml(){
    const list=S.drafts.filter(x=>!S.draft||x.draftId!==S.draft.draftId);
    if(!list.length)return '';
    return `<div class="admin-card"><h3>Draft scan</h3><div class="table-wrap"><table class="admin-table"><thead><tr><th>Judul</th><th>Status</th><th>Chapter</th><th>Diperbarui</th><th>Aksi</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.title)}</td><td>${esc(STATE[x.state]||x.state)}</td><td>${x.completed}/${x.chapters}</td><td>${esc(new Date(x.updatedAt).toLocaleString('id-ID'))}</td><td>${x.state==='PUBLISHED'?`<a class="btn ghost small" href="#detail/${encodeURIComponent(x.publishedComicId||'')}">Lihat</a>`:`<button class="btn ghost small" data-scan-open="${esc(x.draftId)}">Lanjutkan</button>`} <button class="btn danger small" data-scan-discard-id="${esc(x.draftId)}">Buang</button></td></tr>`).join('')}</tbody></table></div></div>`;
  }
  function inner(){
    return `<div class="admin-card"><h3>Scan Import</h3><p>Masukkan URL sumber (manifest JSON atau sumber lain yang didukung adapter). Hasil scan menjadi <b>draft</b> yang tidak tampil di katalog publik sampai Anda mempublikasikannya.</p>
      <form id="scan-form" class="admin-row"><input class="feed-url" id="scan-url" type="url" required placeholder="https://sumber.example/seri/manifest.json" value="${esc(S.url)}" ${S.busy?'disabled':''}><button class="btn" id="scan-submit" ${S.busy?'disabled':''}>${S.busy?'Memindai…':'Scan link'}</button></form>
      ${S.error?`<p class="form-error" role="alert">${esc(S.error)}</p>`:'<p class="form-error"></p>'}</div>
      ${S.draft?previewHtml(S.draft):''}${draftListHtml()}`;
  }
  function tabHtml(){return `<div id="scan-root">${inner()}</div>`;}
  function paint(){const root=document.getElementById('scan-root');if(root){root.innerHTML=inner();}}
  function paintProgress(){const box=document.getElementById('scan-progress');if(box&&S.draft)box.innerHTML=progressHtml(S.progress,S.draft);}

  async function refreshList(){try{S.drafts=(await call('/api/admin/scan')).drafts;}catch(e){S.error=e.message;}}
  async function openDraft(id){
    S.error='';
    try{S.draft=await call(`/api/admin/scan/${encodeURIComponent(id)}`);S.progress=null;
      if(S.draft.state==='DOWNLOADING'||S.draft.job){await pollOnce();}
      if(S.draft.state==='DOWNLOADING')startPolling();}
    catch(e){S.error=e.message;}
    paint();
  }
  async function pollOnce(){
    if(!S.draft)return;
    const id=S.draft.draftId,token=S.token;
    try{
      const p=await call(`/api/admin/scan/${encodeURIComponent(id)}/progress`);
      if(token!==S.token||!S.draft||S.draft.draftId!==id)return;
      S.progress=p;S.pollError='';
      if(p.state!=='DOWNLOADING'){stop();S.draft=await call(`/api/admin/scan/${encodeURIComponent(id)}`);await refreshList();paint();return;}
      paintProgress();
    }catch(e){ if(token===S.token){S.pollError=ScanFormat.pollErrorMessage(e);paintProgress();} }
  }
  function startPolling(){if(S.timer)clearInterval(S.timer);const t=S.token;S.timer=setInterval(()=>{if(t!==S.token)return;pollOnce();},2000);}

  async function onScan(e){
    e.preventDefault();
    S.url=document.getElementById('scan-url').value.trim();S.busy=true;S.error='';paint();
    try{stop();S.draft=await call('/api/admin/scan','POST',{url:S.url});S.progress=null;await refreshList();}
    catch(err){S.error=err.code==='DRAFT_EXISTS'?`${err.message}`:err.message;if(err.code==='DRAFT_EXISTS'&&err.data.draftId){S.error='';await openDraft(err.data.draftId);S.busy=false;paint();toast('Draft untuk URL ini sudah ada — dilanjutkan.');return;}}
    S.busy=false;paint();
  }
  async function startDownload(body){
    try{await call(`/api/admin/scan/${encodeURIComponent(S.draft.draftId)}/download`,'POST',body);S.draft=await call(`/api/admin/scan/${encodeURIComponent(S.draft.draftId)}`);S.progress=null;paint();await pollOnce();startPolling();}
    catch(err){
      if(err.code==='CONFIRM_REPLACE_REQUIRED'&&confirm(`${err.message}\n\nLanjutkan dan ganti chapter yang sudah ada?`))return startDownload({...body,confirmReplace:true});
      S.error=err.message;paint();
    }
  }
  async function onAction(action){
    const d=S.draft;if(!d)return;
    if(action==='download'){
      const n=d.counts.new,ex=d.counts.exists;
      if(!n&&!ex)return;
      let msg=`Unduh ${n} chapter baru dari "${d.comic.title}"?\nPastikan ruang disk server cukup (satu chapter dapat mencapai 150 MB).`;
      if(!confirm(msg))return;
      let body={mode:'new-only'};
      if(ex>0&&confirm(`${ex} chapter sudah ada di komik. Unduh ulang dan ganti chapter tersebut juga?\n(OK = ganti, Batal = lewati yang sudah ada)`))body={mode:'all',confirmReplace:true};
      if(!n&&body.mode!=='all')return;
      await startDownload(body);
    }else if(action==='cancel'){
      if(!confirm('Batalkan unduhan yang sedang berjalan?'))return;
      try{await call(`/api/admin/scan/${encodeURIComponent(d.draftId)}/cancel`,'POST',{});toast('Pembatalan diminta.');}catch(err){S.error=err.message;paint();}
    }else if(action==='retry-failed'){await startDownload({mode:'failed-only'});}
    else if(action==='discard'){await discard(d.draftId);}
  }
  async function discard(id){
    if(!confirm('Buang draft ini beserta semua berkas unduhannya?'))return;
    try{await call(`/api/admin/scan/${encodeURIComponent(id)}`,'DELETE');if(S.draft?.draftId===id){stop();S.draft=null;S.progress=null;}await refreshList();paint();toast('Draft dibuang.');}catch(err){S.error=err.message;paint();}
  }
  async function bind(){
    const root=document.getElementById('scan-root');
    if(!root){stop();return;}
    if(!root._bound){
      root._bound=true;
      root.addEventListener('submit',e=>{if(e.target.id==='scan-form')onScan(e);});
      root.addEventListener('click',async e=>{
        const t=e.target.closest('button');if(!t)return;
        if(t.dataset.scanAction)await onAction(t.dataset.scanAction);
        else if(t.dataset.scanOpen)await openDraft(t.dataset.scanOpen);
        else if(t.dataset.scanDiscardId)await discard(t.dataset.scanDiscardId);
        else if(t.dataset.scanRetry){try{await call(`/api/admin/scan/${encodeURIComponent(S.draft.draftId)}/chapters/${encodeURIComponent(t.dataset.scanRetry)}/retry`,'POST',{});S.draft=await call(`/api/admin/scan/${encodeURIComponent(S.draft.draftId)}`);paint();await pollOnce();startPolling();}catch(err){S.error=err.message;paint();}}
      });
    }
    if(!S.loaded){S.loaded=true;await refreshList();}
    else await refreshList();
    if(S.draft&&S.draft.state==='DOWNLOADING'&&!S.timer)startPolling();
    paint();
  }

  // ---------- halaman finalisasi (tata letak halaman detail) ----------
  const fin={d:null};
  const opt=(list,val)=>list.map(x=>`<option ${x===val?'selected':''}>${esc(x)}</option>`).join('');
  function finalizeHtml(d){
    const c=d.comic,hasCover=Boolean(c.cover);
    const published=d.state==='PUBLISHED';
    return `<div class="detail-hero" style="--detail-bg:url('${esc(c.cover||'')}')" data-draft="${esc(d.draftId)}"><div><img class="detail-cover" id="fin-cover-img" src="${esc(c.cover||fallbackImg)}" alt="Sampul ${esc(c.title)}"><label class="btn ghost small cover-pick">Ganti sampul<input id="fin-cover" type="file" accept="image/png,image/jpeg,image/webp" hidden></label></div>
      <div class="detail-copy"><span class="eyebrow">Finalisasi draft · ${esc(STATE[d.state]||d.state)}</span>
      <input class="control fin-title" id="fin-title" value="${esc(c.title)}" maxlength="140" aria-label="Judul" placeholder="Judul komik">
      <input class="control" id="fin-alt" value="${esc(c.alt||'')}" maxlength="140" aria-label="Judul alternatif" placeholder="Judul alternatif (opsional)" style="margin-top:6px">
      <div class="detail-facts fin-facts"><label class="fact">Tipe <select id="fin-type" class="control">${c.type?'':'<option value="">— pilih —</option>'}${opt(['Manhwa','Manhua','Manga'],c.type)}</select></label><label class="fact">Status <select id="fin-status" class="control">${c.status?'':'<option value="">— pilih —</option>'}${opt(['Berjalan','Tamat','Hiatus'],c.status)}</select></label><label class="fact">Kreator <input class="control" id="fin-author" value="${esc(c.author||'')}" maxlength="140"></label><label class="fact">Tahun <input class="control" id="fin-year" type="number" min="1900" max="2100" value="${esc(c.year??'')}" style="width:90px"></label></div>
      <textarea class="control fin-synopsis" id="fin-synopsis" rows="5" maxlength="2000" aria-label="Sinopsis" placeholder="Sinopsis">${esc(c.synopsis||'')}</textarea>
      <input class="control" id="fin-genres" value="${esc((c.genres||[]).join(', '))}" aria-label="Genre" placeholder="Genre, dipisahkan koma" style="margin-top:8px">
      <p class="form-error" id="fin-error" role="alert"></p>
      <div class="hero-actions" style="margin-top:12px"><button class="btn" id="fin-publish" ${published?'disabled':''}>Publish ke katalog</button><button class="btn ghost" id="fin-save" ${published?'disabled':''}>Simpan perubahan</button><button class="btn danger" id="fin-discard">Buang draft</button><a class="btn ghost" href="#admin/scan">← Scan Import</a></div></div></div>
      <div class="detail-lower"><section><div class="section-heading"><div><h2>Daftar chapter</h2><p>${d.counts.included} dari ${d.counts.total} chapter akan dipublikasikan. Ubah nomor/judul, keluarkan, atau hapus chapter sebelum publish.</p></div></div>
      <div class="chapter-list fin-chapters">${d.chapters.map(ch=>finalizeRow(ch,published)).join('')||'<div class="empty">Tidak ada chapter.</div>'}</div></section>
      <aside class="side-panel"><h3>Informasi sumber</h3><p class="muted">Adapter: ${esc(d.adapterLabel)}</p><p class="muted" style="word-break:break-all">${esc(d.canonicalUrl)}</p>
      <p class="muted">Selesai diunduh: ${d.counts.completed}/${d.counts.total}${d.counts.failed?` · ${d.counts.failed} gagal`:''}</p>
      ${d.existingComicId?`<p class="warn-line">ℹ Komik sudah ada di katalog. Publish hanya <b>menambah</b> chapter; metadata yang ada tidak diubah.</p>`:''}${warningsHtml(d)}
      <p class="muted" style="font-size:10px">Draft ini belum tampil di katalog publik.</p></aside></div>`;
  }
  function finalizeRow(ch,published){
    const bad=ch.excluded?'':(ch.issues.includes('duplicate_number')||ch.issues.includes('number_required')||(ch.status!=='COMPLETED'))?'row-error':'';
    return `<div class="chapter-row fin-row ${ch.excluded?'row-muted':''} ${bad}" data-key="${esc(ch.key)}"><label class="fin-inc"><input type="checkbox" class="fin-include" ${ch.excluded?'':'checked'} ${published?'disabled':''} aria-label="Sertakan chapter"></label>
      <span class="fin-fields"><input class="control fin-num" value="${esc(ch.number??'')}" placeholder="No." inputmode="decimal" aria-label="Nomor chapter" ${published?'disabled':''}><input class="control fin-ctitle" value="${esc(ch.title||'')}" maxlength="140" placeholder="Judul chapter" aria-label="Judul chapter" ${published?'disabled':''}></span>
      <span class="fin-info"><small>${esc(ch.date||'')}</small> ${ch.flag==='EXISTS'?badge('SUDAH ADA',''):''} ${statusBadge(ch.status)||badge('belum diunduh','warn')} ${ScanFormat.pagesLabel(ch)?`<small>${ScanFormat.pagesLabel(ch)}</small>`:''} ${issueBadges(ch.issues)}${ch.errorMessage?`<br><small class="err-text">${esc(ch.errorCode||'')} ${esc(ch.errorMessage)}</small>`:''}</span>
      <span class="fin-act">${(ch.status===null||ch.status==='FAILED'||ch.status==='CANCELLED')&&!published?`<button class="btn ghost small fin-retry">${ch.status===null?'Unduh':'Coba lagi'}</button>`:''}${published?'':'<button class="btn danger small fin-delete">Hapus</button>'}</span></div>`;
  }
  function collect(){
    const val=id=>document.getElementById(id).value;
    const year=val('fin-year').trim();
    return {comic:{title:val('fin-title'),alt:val('fin-alt'),synopsis:val('fin-synopsis'),author:val('fin-author'),type:val('fin-type')||null,status:val('fin-status')||null,year:year===''?null:Number(year),genres:val('fin-genres').split(',').map(x=>x.trim()).filter(Boolean)},
      chapters:[...document.querySelectorAll('.fin-row')].map(r=>({key:r.dataset.key,number:r.querySelector('.fin-num').value.trim(),title:r.querySelector('.fin-ctitle').value,excluded:!r.querySelector('.fin-include').checked}))};
  }
  async function reloadFinalize(id){fin.d=await call(`/api/admin/scan/${encodeURIComponent(id)}`);const root=document.getElementById('fin-root');if(root)root.innerHTML=finalizeHtml(fin.d);}
  function showErr(msg,keys=[]){const el=document.getElementById('fin-error');if(el)el.textContent=msg||'';document.querySelectorAll('.fin-row').forEach(r=>r.classList.toggle('row-error',keys.includes(r.dataset.key)));if(keys.length)document.querySelector(`.fin-row[data-key="${keys[0]}"]`)?.scrollIntoView({block:'center'});}
  async function save(id){const body=collect();fin.d=await call(`/api/admin/scan/${encodeURIComponent(id)}`,'PATCH',body);}
  async function finalizePage(id){
    stop();
    try{fin.d=await call(`/api/admin/scan/${encodeURIComponent(id)}`);}
    catch(e){return `<div class="empty"><b>Draft tidak ditemukan</b>${esc(e.message)}<p><a class="btn" href="#admin/scan">Kembali</a></p></div>`;}
    return `<div id="fin-root">${finalizeHtml(fin.d)}</div>`;
  }
  function bindFinalize(){
    const root=document.getElementById('fin-root');if(!root||root._bound)return;root._bound=true;
    const id=()=>fin.d.draftId;
    root.addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b)return;
      try{
        if(b.id==='fin-save'){showErr('');await save(id());await reloadFinalize(id());toast('Perubahan disimpan.');}
        else if(b.id==='fin-publish'){
          showErr('');
          const pubTitle=document.getElementById('fin-title').value.trim()||fin.d.comic.title,pubCount=document.querySelectorAll('.fin-include:checked').length;
          if(!confirm(`Publikasikan "${pubTitle}" dengan ${pubCount} chapter ke katalog publik?`))return;
          await save(id());
          const r=await call(`/api/admin/scan/${encodeURIComponent(id())}/publish`,'POST',{});
          toast(`Dipublikasikan: ${r.chaptersPublished} chapter, ${r.pagesPublished} halaman.`);
          try{catalog=await api('/api/catalog');}catch{}
          location.hash=`detail/${encodeURIComponent(r.comicId)}`;
        }
        else if(b.id==='fin-discard'){if(!confirm('Buang draft ini beserta semua berkas unduhannya?'))return;await call(`/api/admin/scan/${encodeURIComponent(id())}`,'DELETE');S.draft=null;toast('Draft dibuang.');location.hash='admin/scan';}
        else if(b.classList.contains('fin-delete')){const row=b.closest('.fin-row');if(!confirm('Hapus chapter ini dari draft?'))return;fin.d=await call(`/api/admin/scan/${encodeURIComponent(id())}`,'PATCH',{chapters:[{key:row.dataset.key,delete:true}]});await reloadFinalize(id());}
        else if(b.classList.contains('fin-retry')){const row=b.closest('.fin-row');await save(id());await call(`/api/admin/scan/${encodeURIComponent(id())}/chapters/${encodeURIComponent(row.dataset.key)}/retry`,'POST',{});S.draft=fin.d;toast('Chapter diantrekan ulang. Buka Scan Import untuk melihat progres.');location.hash='admin/scan';await openDraft(id());}
      }catch(err){
        if(err.code==='DUPLICATE_CHAPTER_NUMBER')showErr(err.message,err.data.keys||[]);
        else if(['CHAPTER_NOT_READY','CHAPTER_NUMBER_REQUIRED'].includes(err.code))showErr(err.message,err.data.keys||[]);
        else showErr(err.message);
      }
    });
    root.addEventListener('change',async e=>{
      if(e.target.id==='fin-cover'){
        const file=e.target.files[0];if(!file)return;
        if(file.size>5_000_000){showErr('Ukuran sampul melewati batas 5 MB.');return;}
        const data=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(Error('Berkas gagal dibaca.'));r.readAsDataURL(file);});
        try{await call(`/api/admin/scan/${encodeURIComponent(id())}`,'PATCH',{comic:{coverData:data}});await reloadFinalize(id());toast('Sampul diganti.');}catch(err){showErr(err.message);}
      }
      if(e.target.classList.contains('fin-include')){e.target.closest('.fin-row').classList.toggle('row-muted',!e.target.checked);}
    });
  }
  return {tabHtml,bind,stop,finalizePage,bindFinalize,_state:S};
})();
