const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const chapterMedia = require('./lib/chapter-media');
const {comicStorageKey, resolveMediaUrl, saveCover, saveChapterPdf, saveChapterImages, saveDownloadedChapterImages, renderPdfPages, migrateLegacyComicMedia, removeComicStorage, removeChapterStorage} = chapterMedia;
const {importChapterFromSeries, SourceAccessError} = require('./lib/source-scraper');

// Load local server-only settings without exposing credentials to browser code.
try {
  const envFile = fsSync.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z\d_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'db.json');
const DATA_DIR = path.dirname(DATA);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 40_000_000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
const sessions = new Map();
const loginAttempts = new Map();

const seed = {
  comics: [
    { id:'swordmasters-youngest-son', title:"Swordmaster's Youngest Son", alt:'', type:'Manhwa', status:'Berjalan', genres:['Aksi','Petualangan','Fantasi','Seni Bela Diri'], rating:7.7, year:2022, author:'', synopsis:'Putra termuda dari keluarga pendekar Runcandel pernah dianggap tidak berbakat. Setelah kehidupannya berakhir, ia mendapat kesempatan kedua untuk menentukan jalan dan menggunakan kekuatannya sendiri.', cover:'', source:'Kiryuu ID', sourceUrl:'https://v7.kiryuu.to/manga/swordmasters-youngest-son/', externalContent:true, metadataCheckedAt:'2026-09-28', chapters:[] },
    { id:'senja-di-ujung-langit', title:'Senja di Ujung Langit', alt:'The Horizon Afterglow', type:'Manhwa', status:'Berjalan', genres:['Fantasi','Petualangan','Aksi'], rating:9.2, year:2024, author:'Studio Awan', synopsis:'Ketika langit retak dan pulau-pulau melayang mulai jatuh, seorang kartografer muda menemukan peta yang menggambar masa depan.', cover:'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=700&q=85', banner:'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1800&q=85', chapters:[{id:'ch-24',number:24,title:'Peta yang Terbakar',date:'28 Sep 2026'},{id:'ch-23',number:23,title:'Kota di Atas Awan',date:'21 Sep 2026'},{id:'ch-22',number:22,title:'Kompas Retak',date:'14 Sep 2026'}] },
    { id:'arsip-bulan-biru', title:'Arsip Bulan Biru', alt:'Blue Moon Archive', type:'Manhwa', status:'Berjalan', genres:['Drama','Misteri','Romansa'], rating:8.8, year:2025, author:'Mira Han', synopsis:'Di perpustakaan yang hanya muncul saat bulan biru, setiap buku menyimpan satu kenangan yang terlupakan.', cover:'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-12',number:12,title:'Nama di Sampul',date:'27 Sep 2026'},{id:'ch-11',number:11,title:'Lantai Ketujuh',date:'20 Sep 2026'}] },
    { id:'kota-tanpa-pagi', title:'Kota Tanpa Pagi', alt:'City Without Dawn', type:'Manhwa', status:'Tamat', genres:['Aksi','Drama','Fantasi'], rating:9.0, year:2023, author:'J. Kwon', synopsis:'Seorang kurir melintasi kota yang kehilangan matahari untuk mengantar surat terakhir kepada sang penjaga waktu.', cover:'https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-48',number:48,title:'Hari Pertama',date:'12 Jun 2026'},{id:'ch-47',number:47,title:'Jam Terakhir',date:'05 Jun 2026'}] },
    { id:'ramuan-untuk-naga', title:'Ramuan untuk Naga', alt:'A Potion for the Dragon', type:'Manhua', status:'Berjalan', genres:['Komedi','Fantasi','Romansa'], rating:8.4, year:2025, author:'Lin Yao', synopsis:'Apoteker desa yang canggung mendapat pelanggan tak terduga: naga kuno yang hanya bisa berubah bentuk saat bersin.', cover:'https://images.unsplash.com/photo-1518709594023-6eab9bab7b23?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-31',number:31,title:'Tamu Bersisik',date:'26 Sep 2026'},{id:'ch-30',number:30,title:'Resep Rahasia',date:'19 Sep 2026'}] },
    { id:'langkah-kedua', title:'Langkah Kedua', alt:'The Second Step', type:'Manga', status:'Berjalan', genres:['Olahraga','Drama'], rating:8.7, year:2024, author:'Aki Mori', synopsis:'Setelah cedera mengakhiri karier larinya, Nara menemukan alasan baru untuk kembali ke lintasan.', cover:'https://images.unsplash.com/photo-1530549387789-4c1017266635?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-19',number:19,title:'Garis Mulai',date:'25 Sep 2026'},{id:'ch-18',number:18,title:'Napas Panjang',date:'18 Sep 2026'}] },
    { id:'kebun-bintang', title:'Kebun Bintang', alt:'Garden of Stars', type:'Manhwa', status:'Berjalan', genres:['Slice of Life','Fantasi','Drama'], rating:8.6, year:2025, author:'Dara Kim', synopsis:'Di atap apartemen sempit, seorang penjaga malam menanam bunga yang hanya mekar di bawah cahaya bintang.', cover:'https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-8',number:8,title:'Benih Pertama',date:'24 Sep 2026'}] },
    { id:'kode-terakhir', title:'Kode Terakhir', alt:'The Last Protocol', type:'Manhwa', status:'Hiatus', genres:['Aksi','Fiksi Ilmiah','Misteri'], rating:9.1, year:2022, author:'Zero Unit', synopsis:'Di kota yang dijalankan kecerdasan buatan, seorang teknisi menemukan satu baris kode yang seharusnya sudah dihapus.', cover:'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-56',number:56,title:'Mode Aman',date:'01 Aug 2026'}] },
    { id:'surat-untuk-kemarin', title:'Surat untuk Kemarin', alt:'Letters to Yesterday', type:'Manga', status:'Berjalan', genres:['Romansa','Drama'], rating:8.3, year:2024, author:'Hana Sato', synopsis:'Dua tetangga bertukar surat lewat kotak pos tua yang entah bagaimana mengirim pesan ke masa lalu.', cover:'https://images.unsplash.com/photo-1490730141103-6cac27aaab94?auto=format&fit=crop&w=700&q=85', chapters:[{id:'ch-14',number:14,title:'Kertas Lipat',date:'22 Sep 2026'}] }
  ],
  announcements:[{title:'Selamat datang di Lembar!',date:'28 Sep 2026',body:'Nikmati katalog demo dan fitur lanjut membaca. Semua judul dan chapter pada versi ini adalah data contoh.'},{title:'Pembaruan katalog',date:'20 Sep 2026',body:'Filter genre dan status kini tersedia di halaman katalog.'}],
  connectors:[
    {id:'kiryuu',name:'Kiryuu',method:'Metadata halaman publik',enabled:false,state:'nonaktif',message:'Siap untuk metadata halaman seri saja. Konten chapter hanya tersedia setelah diunggah ke penyimpanan lokal.',lastSync:null,feedUrl:'',intervalMinutes:1440},
    {id:'shinigami',name:'Shinigami',method:'Belum dikonfigurasi',enabled:false,state:'nonaktif',message:'Konektor nonaktif. Tidak ada pengambilan konten yang diuji atau dikonfigurasi.',lastSync:null,feedUrl:'',intervalMinutes:1440},
    {id:'public-feed',name:'Feed Publik (opsional)',method:'JSON/RSS feed',enabled:false,state:'nonaktif',message:'Tambahkan feed JSON/RSS yang diizinkan untuk metadata. Tidak ada sumber aktif.',lastSync:null,feedUrl:'',intervalMinutes:1440},
    {id:'demo-source',name:'Sumber Demo Lokal',method:'JSON lokal + gambar demo',enabled:true,state:'siap',message:'Fixture JSON dan halaman ilustrasi orisinal siap untuk sinkronisasi contoh. Belum dijalankan.',lastSync:null,feedUrl:'local:public/demo-source/manhwa.json',intervalMinutes:5}
  ],
  settings:{adProvider:'',adUnit:'',scheduleEnabled:false},
  ads:[{id:'ad-home-top',label:'Ruang iklan — beranda',placement:'home-top',enabled:false},{id:'ad-detail',label:'Ruang iklan — detail',placement:'detail',enabled:false}]
};

async function loadDb(){ try { const db=JSON.parse((await fs.readFile(DATA,'utf8')).replace(/^\uFEFF/,''));db.users||=[];if(!db.comics.some(c=>c.id==='swordmasters-youngest-son'))db.comics.unshift(structuredClone(seed.comics[0]));if(!db.connectors.some(c=>c.id==='demo-source'))db.connectors.push(structuredClone(seed.connectors.find(c=>c.id==='demo-source')));const connector=db.connectors?.find(c=>c.id==='kiryuu');if(connector&&!connector.feedUrl){connector.method='Metadata halaman publik';connector.feedUrl='https://v7.kiryuu.to/manga/swordmasters-youngest-son/';connector.enabled=false;connector.state='nonaktif';connector.message='Metadata saja; chapter hanya dapat dibaca setelah konten tersedia di penyimpanan lokal.';}for(const comic of db.comics||[]){for(const chapter of comic.chapters||[]){delete chapter.url;chapter.pages=(Array.isArray(chapter.pages)?chapter.pages:[]).filter(page=>{const image=typeof page==='string'?page:(page?.image_url||page?.url||'');return typeof image==='string'&&image.startsWith('/media/');});for(const key of ['fileUrl','pdfUrl'])if(chapter[key]&&!String(chapter[key]).startsWith('/media/'))delete chapter[key];}}await saveDb(db);return db; } catch { await fs.mkdir(path.dirname(DATA),{recursive:true}); const initial=structuredClone(seed);initial.users=[];await saveDb(initial);return initial; } }
let dbPromise = loadDb().then(async db=>{let changed=false;for(const comic of db.comics)if(await migrateLegacyComicMedia(comic))changed=true;if(changed)await saveDb(db);return db;});
async function saveDb(next){ await fs.mkdir(path.dirname(DATA),{recursive:true}); const tmp=DATA+'.tmp'; await fs.writeFile(tmp,JSON.stringify(next,null,2)); await fs.rename(tmp,DATA); }
const chapterJobs=[];
let chapterWorkerActive=false;
function enqueueChapterRender(comicId,chapterId){
  chapterJobs.push({comicId,chapterId});
  void runChapterWorker();
}
async function processChapterRender(job){
  const db=await dbPromise;
  const comic=db.comics.find(item=>item.id===job.comicId);
  const chapter=comic?.chapters?.find(item=>item.id===job.chapterId);
  if(!comic||!chapter||chapter.status==='COMPLETED'||(!chapter.fileUrl&&chapter.importMethod!=='kiryuu-html'))return;

  chapter.status='DOWNLOADING';
  chapter.errorMessage=null;
  await saveDb(db);
  try{
    if(chapter.importMethod==='kiryuu-html'){
      const {chapter: sourceChapter, images}=await importChapterFromSeries(chapter.seriesUrl,chapter.number);
      chapter.pages=await saveDownloadedChapterImages(images,comic.storageKey||comicStorageKey(comic),chapter.number);
      chapter.title=chapter.title||sourceChapter.title||`Chapter ${chapter.number}`;
      chapter.source='Kiryuu · tersimpan lokal';
      chapter.importedAt=new Date().toISOString();
      chapter.status='COMPLETED';
      chapter.errorMessage=null;
      delete chapter.seriesUrl;
      delete chapter.importMethod;
      delete chapter.retryAfter;
      await saveDb(db);
      return;
    }
    const pdfPath=resolveMediaUrl(chapter.fileUrl);
    await fs.access(pdfPath);
    chapter.pages=await renderPdfPages(pdfPath,comic.storageKey||comicStorageKey(comic),chapter.number);
    chapter.pdfUrl='';
    chapter.status='COMPLETED';
    chapter.errorMessage=null;
  }catch(error){
    chapter.pages=[];
    chapter.status='FAILED';
    chapter.errorMessage=error.message||'Proses chapter gagal.';
    if(error instanceof SourceAccessError||error.accessRestricted){
      const connector=db.connectors.find(item=>item.id==='kiryuu');
      if(connector){connector.enabled=false;connector.state='akses-dibatasi';connector.lastSync=new Date().toISOString();connector.message=`Impor chapter dihentikan: ${error.message}${error.retryAfter?` Retry-After: ${error.retryAfter}.`:''}`;}
      chapter.retryAfter=error.retryAfter||null;
    }
  }
  await saveDb(db);
}
async function runChapterWorker(){
  if(chapterWorkerActive)return;
  chapterWorkerActive=true;
  try{while(chapterJobs.length)await processChapterRender(chapterJobs.shift());}
  catch(error){console.error('[chapter-worker]',error.message);}
  finally{chapterWorkerActive=false;if(chapterJobs.length)void runChapterWorker();}
}
dbPromise.then(db=>{
  for(const comic of db.comics)for(const chapter of comic.chapters||[]){
    if(['QUEUED','DOWNLOADING'].includes(chapter.status)&&(chapter.fileUrl||chapter.importMethod==='kiryuu-html'))enqueueChapterRender(comic.id,chapter.id);
  }
}).catch(error=>console.error('[chapter-worker-startup]',error.message));
const json=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj));};
const cookieSession=req=>{const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('lembar_session='))?.slice('lembar_session='.length);const id=raw&&decodeURIComponent(raw);const session=id&&sessions.get(id);if(session&&session.expires>Date.now())return session;if(id)sessions.delete(id);return null;};
const setSession=(res,sessionId)=>res.setHeader('set-cookie',`lembar_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);
const passwordRecord=async password=>{const salt=crypto.randomBytes(16);const hash=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(e,v)=>e?reject(e):resolve(v)));return `${salt.toString('hex')}:${hash.toString('hex')}`;};
const passwordMatches=async(password,record)=>{try{const [s,h]=record.split(':');const expected=Buffer.from(h,'hex');const actual=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(s,'hex'),expected.length,(e,v)=>e?reject(e):resolve(v)));return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);}catch{return false;}};
const safeUrl=(raw)=>{try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)&&!['localhost','127.0.0.1','::1'].includes(u.hostname)&&!/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)?u:null;}catch{return null;}};
const privateIp=ip=>{if(net.isIPv4(ip))return ip.startsWith('10.')||ip.startsWith('127.')||ip.startsWith('169.254.')||ip.startsWith('192.168.')||/^172\.(1[6-9]|2\d|3[01])\./.test(ip)||ip==='0.0.0.0';if(net.isIPv6(ip))return ip==='::1'||ip==='::'||ip.toLowerCase().startsWith('fc')||ip.toLowerCase().startsWith('fd')||/^fe[89ab]/i.test(ip)||ip.toLowerCase().startsWith('::ffff:127.');return true;};
async function publicFeedUrl(raw){const u=safeUrl(raw);if(!u||u.username||u.password||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local'))return null;if(net.isIP(u.hostname))return privateIp(u.hostname)?null:u;try{const records=await dns.lookup(u.hostname,{all:true,verbatim:true});return records.length&&records.every(x=>!privateIp(x.address))?u:null;}catch{return null;}}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>MAX_BODY){reject(Error('Ukuran permintaan terlalu besar'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(b||'{}'));}catch{reject(Error('Format JSON tidak valid'));}});});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const blockedStatus=s=>[401,403,407,429,451].includes(s);
const kiryuuCache=new Map();
async function syncDemoConnector(db,c){
  const fixturePath=path.join(ROOT,'public','demo-source','manhwa.json');const source=JSON.parse(await fs.readFile(fixturePath,'utf8'));
  const comicId=String(source.id||'demo-manhwa').toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,80);const title=String(source.title||'').trim().slice(0,140);
  if(!title||!Array.isArray(source.chapters)||!source.chapters.length)throw Error('Fixture demo tidak berisi judul atau daftar chapter.');
  const candidates=source.chapters.filter(ch=>/^\d+(?:\.\d+)?$/.test(String(ch.chapter))&&Array.isArray(ch.pages)&&ch.pages.length&&ch.pages.length<=50).sort((a,b)=>Number(b.chapter)-Number(a.chapter));
  const latest=candidates[0];if(!latest)throw Error('Tidak ditemukan chapter demo dengan daftar halaman yang valid.');
  let comic=db.comics.find(x=>x.id===comicId);if(!comic){comic={id:comicId,title,type:source.type||'Manhwa',status:source.status||'Berjalan',genres:Array.isArray(source.genres)?source.genres.slice(0,8):[],rating:null,year:Number(source.year)||null,author:String(source.author||''),synopsis:String(source.synopsis||'Data contoh dari fixture lokal.').slice(0,800),cover:String(source.cover||'/demo-source/pages/page-001.svg'),source:'Sumber Demo Lokal',sourceUrl:'/demo-source/manhwa.json',chapters:[]};db.comics.push(comic);}
  comic.chapters||=[];if(comic.chapters.some(ch=>String(ch.number)===String(latest.chapter))){c.state='aktif';c.lastSync=new Date().toISOString();c.message=`Tidak ada chapter baru. Chapter terbaru pada sumber adalah ${latest.chapter}; sudah ada di database.`;await saveDb(db);return {added:0,latest:latest.chapter,message:c.message,lastSync:c.lastSync};}
  const chapterId=`${comicId}-ch-${String(latest.chapter).replace('.','-')}`;const folder=path.join(DATA_DIR,'media',comicId,chapterId);const demoRoot=path.resolve(ROOT,'public','demo-source');const savedPages=[];await fs.mkdir(folder,{recursive:true});
  for(let i=0;i<latest.pages.length;i++){const page=new URL(String(latest.pages[i]),'http://demo.local');if(page.hostname!=='demo.local'||!page.pathname.startsWith('/demo-source/'))throw Error('Halaman demo harus menunjuk aset lokal di /demo-source/.');const sourceFile=path.resolve(ROOT,'public',`.${page.pathname}`);if(!sourceFile.startsWith(demoRoot+path.sep))throw Error('Path halaman demo berada di luar folder aset demo.');const ext=path.extname(sourceFile).toLowerCase();if(!['.svg','.png','.jpg','.jpeg','.webp'].includes(ext))throw Error(`Format gambar tidak diizinkan: ${ext}`);const bytes=await fs.readFile(sourceFile);if(bytes.length>5_000_000)throw Error('Satu halaman demo melebihi batas 5 MB.');const digest=crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16);const filename=`page-${String(i+1).padStart(3,'0')}-${digest}${ext}`;await fs.writeFile(path.join(folder,filename),bytes);savedPages.push(`/media/${comicId}/${chapterId}/${filename}`);}
  comic.chapters.unshift({id:chapterId,number:String(latest.chapter),title:String(latest.title||'').slice(0,140),date:String(latest.date||new Date().toLocaleDateString('id-ID')),pages:savedPages,source:'Sumber Demo Lokal'});
  c.state='aktif';c.lastSync=new Date().toISOString();c.message=`Chapter ${latest.chapter} baru ditemukan dan ${savedPages.length} halaman demo disimpan di server lokal.`;await saveDb(db);return {added:1,latest:latest.chapter,pages:savedPages.length,message:c.message,lastSync:c.lastSync};
}
function decodeEntities(s){return String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));}
async function login(req,res,b,db){const username=String(b.username||'').trim().toLowerCase(),role=b.role==='admin'?'admin':'user',key=`${req.socket.remoteAddress}:${role}:${username}`,attempt=loginAttempts.get(key);if(attempt&&attempt.count>=8&&Date.now()-attempt.at<15*60_000)return json(res,429,{error:'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.'});let valid=false;if(role==='admin')valid=username===ADMIN_USER.toLowerCase()&&String(b.password||'')===ADMIN_PASSWORD;else{const user=(db.users||[]).find(x=>x.username===username);valid=Boolean(user&&await passwordMatches(String(b.password||''),user.passwordHash));}if(!valid){const current=loginAttempts.get(key);loginAttempts.set(key,{count:current&&Date.now()-current.at<15*60_000?current.count+1:1,at:Date.now()});return json(res,401,{error:'Nama pengguna atau kata sandi tidak cocok.'});}loginAttempts.delete(key);const id=crypto.randomBytes(32).toString('base64url'),session={id,username,role,expires:Date.now()+8*60*60_000};sessions.set(id,session);setSession(res,id);return json(res,200,{authenticated:true,username,role});}
function parseKiryuuMetadata(html,pageUrl){
  const attr=(s,n)=>{const m=s.match(new RegExp(`\\b${n}\\s*=\\s*(["'])(.*?)\\1`,'i'));return m?decodeEntities(m[2]):'';};
  const meta={}; for(const m of html.matchAll(/<meta\b([^>]*)>/gi)){const name=(attr(m[1],'property')||attr(m[1],'name')).toLowerCase();if(name)meta[name]=attr(m[1],'content');}
  const getText=s=>decodeEntities(s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
  let title=meta['og:title']||'';if(!title){const h=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);title=h?getText(h[1]):'';}title=title.replace(/^Baca\s+/i,'').replace(/\s+Bahasa Indonesia.*$/i,'').replace(/\s*[|–-]\s*Kiryuu.*$/i,'').trim().slice(0,140);
  const synopsis=(meta.description||meta['og:description']||'').slice(0,900);
  const plain=getText(html).toLowerCase();const genres=[];for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){const href=attr(m[1],'href');if(/\/genre\//i.test(href)){const g=getText(m[2]);if(g&&!genres.includes(g))genres.push(g);}}
    if(!title||!/^https:\/\/(?:www\.)?v7\.kiryuu\.to\/manga\//i.test(pageUrl))throw Error('Halaman tidak dikenali sebagai halaman seri Kiryuu publik.');

  const ratingMatch=plain.match(/([0-9]+(?:\.[0-9]+)?)\s*ratings?/i);const yearMatch=plain.match(/\breleased\s+(20\d{2})\b/i);const status=/\b(completed|complete|tamat)\b/i.test(plain)?'Tamat':/\b(hiatus|on hold)\b/i.test(plain)?'Hiatus':'Berjalan';
  return {id:'kiryuu-'+pageUrl.match(/\/manga\/([^/]+)/i)[1].toLowerCase().replace(/[^a-z0-9-]/g,'-'),title,type:'Manhwa',status,genres:genres.slice(0,8),rating:ratingMatch?Number(ratingMatch[1]):null,year:yearMatch?Number(yearMatch[1]):null,author:'',synopsis:synopsis||'Sinopsis tersedia di halaman seri sumber.',cover:'',source:'Kiryuu ID',sourceUrl:pageUrl,externalContent:true,chapters:[]};
}

async function syncConnector(id){
  const db=await dbPromise, c=db.connectors.find(x=>x.id===id); if(!c)throw Object.assign(Error('Konektor tidak ditemukan'),{status:404});
  if(!c.enabled)throw Object.assign(Error('Aktifkan konektor terlebih dahulu.'),{status:400});
  if(id==='demo-source'){try{return await syncDemoConnector(db,c);}catch(e){c.state='error';c.lastSync=new Date().toISOString();c.message=`Sinkronisasi demo gagal: ${e.message}`;await saveDb(db);throw Object.assign(e,{status:500});}}
  if(!['public-feed','kiryuu'].includes(id))throw Object.assign(Error('Konektor ini nonaktif karena tidak ada metode publik yang diverifikasi.'),{status:400});
  const u=await publicFeedUrl(c.feedUrl);if(!u)throw Object.assign(Error('URL feed tidak valid atau mengarah ke host lokal/nonpublik.'),{status:400});
  if(id==='kiryuu'&&(u.hostname!=='v7.kiryuu.to'||!u.pathname.startsWith('/manga/')||u.pathname.includes('/chapter-')))throw Object.assign(Error('Konektor Kiryuu hanya menerima URL halaman seri publik di v7.kiryuu.to/manga/. Gambar chapter tidak pernah diambil.'),{status:400});
  const agent='LembarMetadataBot/1.0 (+metadata-only; contact: admin of this installation)';
  try {
    if(id==='kiryuu'&&kiryuuCache.has(u.href)&&Date.now()-kiryuuCache.get(u.href).cachedAt<6*60*60*1000){const cached=kiryuuCache.get(u.href).item;const existing=db.comics.find(x=>x.id===cached.id);if(existing)Object.assign(existing,cached,{syncedAt:new Date().toISOString()});else db.comics.push({...cached,syncedAt:new Date().toISOString()});c.state='aktif';c.message='Metadata seri dimuat dari cache 6 jam. Chapter tetap memerlukan berkas lokal.';c.lastSync=new Date().toISOString();await saveDb(db);return {added:existing?0:1,seen:1,cached:true,message:c.message,lastSync:c.lastSync};}
    const robotsUrl=new URL('/robots.txt',u.origin); const rr=await fetch(robotsUrl,{headers:{'user-agent':agent},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(blockedStatus(rr.status)){c.state='akses-dibatasi';c.message=`Akses dibatasi oleh robots.txt server (${rr.status}). Sinkronisasi dihentikan.`;await saveDb(db);throw Object.assign(Error(c.message),{status:403,alreadySaved:true});}
    if(rr.ok){const rules=(await rr.text()).slice(0,200000);let ua=false,disallow=false;for(const line of rules.split(/\r?\n/)){const [k,...v]=line.split(':');if(k?.trim().toLowerCase()==='user-agent')ua=v.join(':').trim()==='*'||v.join(':').trim().toLowerCase()==='lembar';if(ua&&k?.trim().toLowerCase()==='disallow'&&v.join(':').trim()&&u.pathname.startsWith(v.join(':').trim()))disallow=true;}if(disallow){c.state='akses-dibatasi';c.message='Akses dibatasi oleh aturan robots.txt. Sinkronisasi dihentikan.';await saveDb(db);throw Object.assign(Error(c.message),{status:403,alreadySaved:true});}}
    await pause(1200);
    const response=await fetch(u,{headers:{'user-agent':agent,accept:'application/json, application/feed+json, application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(15000),redirect:'error'});
    if(blockedStatus(response.status)){const retry=response.headers.get('retry-after');c.state='akses-dibatasi';c.message=`Akses dibatasi oleh sumber (HTTP ${response.status}${retry?`, Retry-After ${retry}`:''}). Sinkronisasi dihentikan; periksa izin akses.`;c.lastSync=new Date().toISOString();await saveDb(db);throw Object.assign(Error(c.message),{status:403,alreadySaved:true});}
    if(!response.ok)throw Error(`Feed merespons HTTP ${response.status}.`);
    const raw=(await response.text()).slice(0,2_000_000); if(/captcha|verify you are human|access denied|cloudflare|checking your browser/i.test(raw)){c.state='akses-dibatasi';c.message='Sumber menampilkan CAPTCHA atau halaman anti-bot. Sinkronisasi dihentikan; gunakan API/feed resmi yang diizinkan.';c.lastSync=new Date().toISOString();await saveDb(db);throw Object.assign(Error(c.message),{status:403,alreadySaved:true});}
    if(id==='kiryuu'){
      const item=parseKiryuuMetadata(raw,u.href);const existing=db.comics.find(x=>x.id===item.id);const complete={...item,syncedAt:new Date().toISOString()};if(existing)Object.assign(existing,complete);else db.comics.push(complete);kiryuuCache.set(u.href,{item,cachedAt:Date.now()});c.state='aktif';c.message=`Metadata seri “${item.title}” berhasil dibaca. Chapter hanya ditampilkan jika gambar tersedia di penyimpanan lokal.`;c.lastSync=new Date().toISOString();await saveDb(db);return {added:existing?0:1,seen:1,message:c.message,lastSync:c.lastSync};
    }
    let items=[]; const type=response.headers.get('content-type')||'';
    if(type.includes('json')||raw.trim().startsWith('{')||raw.trim().startsWith('[')){const parsed=JSON.parse(raw);items=Array.isArray(parsed)?parsed:(Array.isArray(parsed.items)?parsed.items:Array.isArray(parsed.comics)?parsed.comics:[]);}
    else if(/<rss|<feed|<channel/i.test(raw)){const isAtom=/<feed\b/i.test(raw);items=[...raw.matchAll(isAtom?/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi:/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,30).map(m=>{const val=(tag)=>{const x=m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'));return x?.[1]?.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]*>/g,'').trim()||'';};const link=m[1].match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);return {title:val('title'),url:val('link')||link?.[1]||'',description:val(isAtom?'summary':'description')||val('content')};});}
    else throw Error('Format feed tidak dikenali. Sediakan JSON atau RSS/Atom publik.');
    // Metadata-only allowlist. No image or chapter content URLs are fetched.
    const known=new Set(db.comics.map(x=>x.id));let added=0;
    for(const item of items.slice(0,30)){const title=String(item.title||item.name||'').trim().slice(0,140);if(!title)continue;const id=String(item.id||crypto.createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0,16)).replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,80);if(known.has(id))continue;db.comics.push({id,title,type:['Manhwa','Manhua','Manga'].includes(item.type)?item.type:'Manhwa',status:['Berjalan','Tamat','Hiatus'].includes(item.status)?item.status:'Berjalan',genres:Array.isArray(item.genres)?item.genres.map(String).slice(0,8):[],rating:null,year:Number(item.year)||null,author:String(item.author||'').slice(0,100),synopsis:String(item.description||item.synopsis||'Metadata dari feed publik.').slice(0,800),cover:'',source:'public-feed',syncedAt:new Date().toISOString(),chapters:[]});known.add(id);added++;}
    c.state='aktif';c.message=`Sinkronisasi selesai: ${added} metadata baru ditambahkan dari ${items.length} entri feed. Konten gambar/chapter tidak diambil.`;c.lastSync=new Date().toISOString();await saveDb(db);return {added,seen:items.length,message:c.message,lastSync:c.lastSync};
  } catch(e){if(!e.alreadySaved){c.state='error';c.message=e.name==='TimeoutError'?'Sumber tidak merespons dalam batas waktu. Sinkronisasi dihentikan.':`Sinkronisasi gagal: ${e.message}`;c.lastSync=new Date().toISOString();await saveDb(db);}throw Object.assign(e,{status:e.status||502});}
}

async function createAdminComic(db,b){
  const title=String(b.title||'').trim().slice(0,140),mode=String(b.mode||'');
  if(!title)throw Object.assign(Error('Judul wajib diisi.'),{status:400});
  if(!b.coverData)throw Object.assign(Error('Gambar sampul wajib dipilih.'),{status:400});
  if(!['pdf','source'].includes(mode))throw Object.assign(Error('Pilih metode unggah yang tersedia.'),{status:400});
  const connector=mode==='source'?db.connectors.find(item=>item.id===String(b.sourceId)):null;
  const id=String(b.id||crypto.randomUUID()).slice(0,80),item={id,title,type:b.type||'Manhwa',status:b.status||'Berjalan',genres:Array.isArray(b.genres)?b.genres:[],rating:null,year:Number(b.year)||null,author:String(b.author||''),synopsis:String(b.synopsis||'').slice(0,2000),source:connector?.name||'Unggah PDF',sourceUrl:String(b.sourceUrl||''),chapters:[]};
  item.storageKey=comicStorageKey(item);
  item.cover=await saveCover(b.coverData,item.storageKey);
  if(mode==='pdf'){
    const number=String(b.chapterNumber??'').trim();
    if(!/^\d+(?:\.\d+)?$/.test(number)||!b.pdfData)throw Object.assign(Error('Nomor chapter dan file PDF wajib diisi.'),{status:400});
    const pdf=await saveChapterPdf(b.pdfData,item.storageKey,number);
    item.chapters.push({id:`${id}-ch-${number.replace(/\./g,'-')}`,number,title:String(b.chapterTitle||'').slice(0,140),date:new Date().toLocaleDateString('id-ID'),status:'QUEUED',errorMessage:null,pdfUrl:'',fileUrl:pdf.url,pages:[],source:'Unggah PDF'});
  }else if(!connector)throw Object.assign(Error('Sumber konten tidak ditemukan.'),{status:400});
  db.comics.push(item);await saveDb(db);
  if(mode==='pdf'){enqueueChapterRender(item.id,item.chapters[0].id);return {item,message:'Komik dan PDF tersimpan. Halaman gambar sedang diproses.'};}
  if(!connector.enabled)return {item,message:'Komik tersimpan. Konektor sumber belum aktif; aktifkan dan konfigurasikan dari tab Sinkronisasi.'};
  try{
    const syncResult=await syncConnector(connector.id);let imported=null;
    if(connector.id==='kiryuu'){const match=connector.feedUrl.match(/\/manga\/([^/]+)/i);if(match)imported=db.comics.find(c=>c.id===`kiryuu-${match[1].toLowerCase().replace(/[^a-z0-9-]/g,'-')}`);}
    else if(connector.id==='demo-source'){const fixture=JSON.parse(await fs.readFile(path.join(ROOT,'public','demo-source','manhwa.json'),'utf8'));imported=db.comics.find(c=>c.id===String(fixture.id||'demo-manhwa').toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,80));}
    else imported=db.comics.find(c=>c.title.toLowerCase()===title.toLowerCase()&&c.source==='public-feed');
    if(imported&&imported!==item){Object.assign(imported,{title:item.title,synopsis:item.synopsis,cover:item.cover,author:item.author,type:item.type,storageKey:item.storageKey});db.comics=db.comics.filter(c=>c.id!==id);await saveDb(db);}
    return {item:imported||item,message:`Komik tersimpan. ${syncResult.message}`,syncResult};
  }catch(error){return {item,message:`Komik tersimpan, tetapi konektor berhenti: ${error.message}`,syncResult:null};}
}

async function api(req,res,url){const db=await dbPromise;const method=req.method;
  if(url.pathname==='/api/auth/register'&&method==='POST'){const b=await body(req),username=String(b.username||'').trim().toLowerCase(),password=String(b.password||'');if(!/^[a-z0-9_.-]{3,32}$/.test(username)||password.length<8)return json(res,400,{error:'Nama pengguna harus 3–32 karakter; kata sandi minimal 8 karakter.'});if(username===ADMIN_USER.toLowerCase()||db.users?.some(u=>u.username===username))return json(res,409,{error:'Nama pengguna sudah digunakan.'});db.users||=[];db.users.push({id:crypto.randomUUID(),username,passwordHash:await passwordRecord(password),role:'user',createdAt:new Date().toISOString()});await saveDb(db);return login(req,res,{username,password,role:'user'},db);}
  if(url.pathname==='/api/auth/login'&&method==='POST'){const b=await body(req);return login(req,res,b,db);}
  if(url.pathname==='/api/auth/logout'&&method==='POST'){const session=cookieSession(req);if(session)sessions.delete(session.id);res.setHeader('set-cookie','lembar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
  if(url.pathname==='/api/auth/me'&&method==='GET'){const session=cookieSession(req);return json(res,200,session?{authenticated:true,role:session.role,username:session.username}:{authenticated:false});}
  const session=cookieSession(req);
  if(url.pathname.startsWith('/api/admin')&&session?.role!=='admin')return json(res,401,{error:'Silakan masuk menggunakan akun admin.'});
  if(url.pathname==='/api/catalog'&&method==='GET')return json(res,200,{comics:db.comics,announcements:db.announcements,ads:db.ads.filter(a=>a.enabled)});
  if(url.pathname==='/api/connectors'&&method==='GET')return json(res,200,{connectors:db.connectors.map(({id,name,method,enabled,state,message,lastSync,intervalMinutes})=>({id,name,method,enabled,state,message,lastSync,intervalMinutes}))});
  if(url.pathname==='/api/admin'&&method==='GET')return json(res,200,{connectors:db.connectors,announcements:db.announcements,ads:db.ads,settings:db.settings,comics:db.comics});
  if(url.pathname==='/api/admin/comics'&&method==='POST'){try{return json(res,201,await createAdminComic(db,await body(req)));}catch(error){return json(res,error.status||400,{error:error.message||'Komik gagal disimpan.'});}}
  if(url.pathname.startsWith('/api/admin/comics/')&&method==='DELETE'){const id=decodeURIComponent(url.pathname.split('/').pop());const comic=db.comics.find(c=>c.id===id);const mediaRoot=path.resolve(DATA_DIR,'media');if(comic?.storageKey)await removeComicStorage(comic.storageKey);if(comic?.source==='Sumber Demo Lokal'){const target=path.resolve(mediaRoot,id);if(target.startsWith(mediaRoot+path.sep))await fs.rm(target,{recursive:true,force:true});}db.comics=db.comics.filter(c=>c.id!==id);await saveDb(db);return json(res,200,{ok:true});}
  if(url.pathname.startsWith('/api/admin/comics/')&&url.pathname.endsWith('/chapters/scrape')&&method==='POST'){
    const id=decodeURIComponent(url.pathname.split('/')[4]),comic=db.comics.find(item=>item.id===id);
    if(!comic)return json(res,404,{error:'Komik tidak ditemukan.'});
    const connector=db.connectors.find(item=>item.id==='kiryuu');
    if(connector?.state==='akses-dibatasi')return json(res,423,{error:'Konektor Kiryuu ditandai akses dibatasi. Impor otomatis dihentikan; gunakan unggah lokal atau sumber lain yang diizinkan.'});
    const b=await body(req),number=String(b.number??'').trim(),seriesUrl=String(b.seriesUrl||'').trim();
    if(!/^\d+(?:\.\d+)?$/.test(number))return json(res,400,{error:'Masukkan nomor chapter yang valid.'});
    const source=await publicFeedUrl(seriesUrl);
    if(!source||source.protocol!=='https:'||source.hostname!=='v7.kiryuu.to'||!source.pathname.startsWith('/manga/')||/\/chapter-/i.test(source.pathname))return json(res,400,{error:'Masukkan URL halaman seri HTTPS v7.kiryuu.to/manga/…'});
    comic.chapters||=[];
    if(comic.chapters.some(ch=>String(ch.number)===number))return json(res,409,{error:'Nomor chapter tersebut sudah ada. Hapus data chapter lama sebelum mencoba ulang.'});
    comic.storageKey=comicStorageKey(comic);
    const chapter={id:crypto.randomUUID(),number,title:String(b.title||'').slice(0,140),date:new Date().toLocaleDateString('id-ID'),status:'QUEUED',errorMessage:null,pages:[],source:'Kiryuu · proses lokal',seriesUrl:source.href,importMethod:'kiryuu-html'};
    comic.chapters.unshift(chapter);
    await saveDb(db);
    enqueueChapterRender(comic.id,chapter.id);
    return json(res,202,{message:`Chapter ${number} masuk antrean. Server akan memeriksa robots.txt, mengambil halaman yang diizinkan, lalu menyimpan gambarnya secara lokal.`,comicId:comic.id,chapterId:chapter.id,status:chapter.status});
  }
  if(url.pathname.startsWith('/api/admin/comics/')&&url.pathname.endsWith('/chapters/images')&&method==='POST'){
    const id=decodeURIComponent(url.pathname.split('/')[4]),comic=db.comics.find(item=>item.id===id);
    if(!comic)return json(res,404,{error:'Komik tidak ditemukan.'});
    const b=await body(req),number=String(b.number??'').trim();
    if(!/^\d+(?:\.\d+)?$/.test(number))return json(res,400,{error:'Nomor chapter harus berupa angka.'});
    if(!Array.isArray(b.images)||b.images.length===0)return json(res,400,{error:'Pilih gambar halaman chapter terlebih dahulu.'});
    comic.chapters||=[];
    if(comic.chapters.some(ch=>String(ch.number)===number))return json(res,409,{error:'Nomor chapter tersebut sudah ada.'});
    comic.storageKey=comicStorageKey(comic);
    let pages=[];
    try{
      pages=await saveChapterImages(b.images,comic.storageKey,number);
      const chapter={id:crypto.randomUUID(),number,title:String(b.title||'').slice(0,140),date:new Date().toLocaleDateString('id-ID'),status:'COMPLETED',errorMessage:null,pages,source:'Unggah gambar lokal'};
      comic.chapters.unshift(chapter);
      await saveDb(db);
      return json(res,201,chapter);
    }catch(error){
      comic.chapters=comic.chapters.filter(ch=>!pages.some(page=>ch.pages?.includes(page)));
      await Promise.all(pages.map(page=>fs.rm(resolveMediaUrl(page.image_url),{force:true}).catch(()=>{})));
      return json(res,error.status||400,{error:error.message||'Gambar chapter gagal disimpan.'});
    }
  }
  if(url.pathname.startsWith('/api/admin/comics/')&&url.pathname.endsWith('/chapters')&&method==='POST'){const id=decodeURIComponent(url.pathname.split('/')[4]);const comic=db.comics.find(c=>c.id===id);if(!comic)return json(res,404,{error:'Komik tidak ditemukan.'});const b=await body(req);if(!b.number)return json(res,400,{error:'Nomor chapter wajib diisi.'});comic.chapters ||= [];const ch={id:String(b.id||crypto.randomUUID()).slice(0,80),number:Number(b.number),title:String(b.title||'').slice(0,140),date:String(b.date||new Date().toLocaleDateString('id-ID'))};if(comic.chapters.some(x=>String(x.number)===String(ch.number)))return json(res,409,{error:'Nomor chapter tersebut sudah ada.'});comic.chapters.unshift(ch);await saveDb(db);return json(res,201,ch);}
  if(url.pathname.startsWith('/api/admin/chapters/')&&method==='DELETE'){const id=decodeURIComponent(url.pathname.split('/').pop());for(const comic of db.comics){const chapter=(comic.chapters||[]).find(ch=>ch.id===id);if((chapter?.fileUrl||chapter?.pages?.length)&&comic.storageKey)await removeChapterStorage(comic.storageKey,chapter.number);if(chapter&&comic.source==='Sumber Demo Lokal'){const mediaRoot=path.resolve(DATA_DIR,'media'),target=path.resolve(mediaRoot,comic.id,id);if(target.startsWith(mediaRoot+path.sep))await fs.rm(target,{recursive:true,force:true});}comic.chapters=(comic.chapters||[]).filter(ch=>ch.id!==id);}await saveDb(db);return json(res,200,{ok:true});}
  if(url.pathname.startsWith('/api/admin/connectors/')&&method==='PATCH'){const c=db.connectors.find(x=>x.id===decodeURIComponent(url.pathname.split('/').pop()));if(!c)return json(res,404,{error:'Konektor tidak ditemukan.'});const b=await body(req);if(b.enabled===true&&!['public-feed','kiryuu','demo-source'].includes(c.id))return json(res,400,{error:'Konektor ini tetap nonaktif sampai ada metode publik yang diizinkan.'});if(b.enabled===true&&c.id!=='demo-source'&&!(String(b.feedUrl??c.feedUrl).trim()))return json(res,400,{error:'Tambahkan URL sumber publik sebelum mengaktifkan sinkronisasi.'});if(typeof b.enabled==='boolean'){c.enabled=b.enabled;if(!b.enabled){if(c.state==='error'||c.state==='akses-dibatasi')c.message+=` Konektor kini nonaktif; sinkronisasi tidak akan diulang sampai admin mengaktifkannya.`;else{c.state='nonaktif';c.message='Konektor dinonaktifkan oleh admin.';}}}if(b.feedUrl!==undefined){const v=String(b.feedUrl).trim();if(c.id==='demo-source'&&v!=='local:public/demo-source/manhwa.json')return json(res,400,{error:'Sumber demo lokal tidak dapat diarahkan ke URL lain.'});if(c.id!=='demo-source'&&v&&!await publicFeedUrl(v))return json(res,400,{error:'Masukkan URL HTTP(S) dengan host publik yang valid.'});if(c.id==='kiryuu'&&v){const parsed=new URL(v);if(parsed.hostname!=='v7.kiryuu.to'||!parsed.pathname.startsWith('/manga/')||parsed.pathname.includes('/chapter-'))return json(res,400,{error:'Gunakan URL halaman seri v7.kiryuu.to/manga/…; URL chapter tidak didukung.'});}c.feedUrl=v;c.method=v?(c.id==='demo-source'?'JSON lokal + gambar demo':c.id==='kiryuu'?'Metadata halaman publik':'JSON/RSS feed'):'Belum dikonfigurasi';}if(b.intervalMinutes!==undefined)c.intervalMinutes=Math.max(c.id==='demo-source'?5:c.id==='kiryuu'?1440:60,Math.min(10080,Number(b.intervalMinutes)||1440));await saveDb(db);return json(res,200,c);}
  if(url.pathname.startsWith('/api/admin/connectors/')&&url.pathname.endsWith('/sync')&&method==='POST'){const id=decodeURIComponent(url.pathname.split('/')[4]);try{return json(res,200,await syncConnector(id));}catch(e){return json(res,e.status||500,{error:e.message});}}
  if(url.pathname==='/api/admin/settings'&&method==='PUT'){const b=await body(req);db.settings={...db.settings,adProvider:String(b.adProvider||'').slice(0,100),adUnit:String(b.adUnit||'').slice(0,180),scheduleEnabled:Boolean(b.scheduleEnabled)};await saveDb(db);return json(res,200,db.settings);}
  if(url.pathname==='/api/admin/announcements'&&method==='POST'){const b=await body(req);if(!b.title?.trim())return json(res,400,{error:'Judul wajib diisi.'});db.announcements.unshift({title:String(b.title).slice(0,120),body:String(b.body||'').slice(0,500),date:new Intl.DateTimeFormat('id-ID',{dateStyle:'long'}).format(new Date())});await saveDb(db);return json(res,201,db.announcements[0]);}
  if(url.pathname==='/api/admin/ads'&&method==='PATCH'){const b=await body(req);const ad=db.ads.find(x=>x.id===b.id);if(!ad)return json(res,404,{error:'Slot tidak ditemukan.'});ad.enabled=Boolean(b.enabled);await saveDb(db);return json(res,200,ad);}
  if(url.pathname==='/api/health')return json(res,200,{ok:true,app:'Lembar'});
  return json(res,404,{error:'Endpoint tidak ditemukan.'});
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf'};
const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://localhost');if(u.pathname.startsWith('/api/'))return await api(req,res,u);
  const pathname=decodeURIComponent(u.pathname);let file;
  if(pathname.startsWith('/media/')){file=path.resolve(DATA_DIR,`.${pathname}`);if(!file.startsWith(path.resolve(DATA_DIR,'media')+path.sep))return json(res,403,{error:'Path media tidak diizinkan.'});}
  else{const publicPath=pathname==='/'?'/index.html':pathname;file=path.resolve(ROOT,'public',`.${publicPath}`);if(!file.startsWith(path.resolve(ROOT,'public')+path.sep))return json(res,403,{error:'Tidak diizinkan.'});}
  const data=await fs.readFile(file),type=mime[path.extname(file)]||'application/octet-stream',headers={'content-type':type,'x-content-type-options':'nosniff','cache-control':pathname.startsWith('/media/')?'public, max-age=86400':'no-cache'};if(type==='application/pdf'){headers['accept-ranges']='bytes';headers['content-disposition']='inline';const range=req.headers.range;if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match){res.writeHead(416,{'content-range':`bytes */${data.length}`});return res.end();}let start=match[1]?Number(match[1]):null,end=match[2]?Number(match[2]):null;if(start===null){const suffix=end;start=Math.max(0,data.length-suffix);end=data.length-1;}else if(end===null)end=data.length-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=data.length){res.writeHead(416,{'content-range':`bytes */${data.length}`});return res.end();}end=Math.min(end,data.length-1);headers['content-range']=`bytes ${start}-${end}/${data.length}`;headers['content-length']=String(end-start+1);res.writeHead(206,headers);return res.end(req.method==='HEAD'?undefined:data.subarray(start,end+1));}}headers['content-length']=String(data.length);res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:data);
}catch(e){if(!res.headersSent)json(res,e.code==='ENOENT'?404:500,{error:e.code==='ENOENT'?'File tidak ditemukan.':e.message||'Terjadi kesalahan server.'});}});
server.listen(PORT,HOST,()=>{console.log(`Lembar siap di http://${HOST}:${PORT}`);if(process.env.ADMIN_PASSWORD)console.log(`Login admin: ${ADMIN_USER} (kata sandi dikonfigurasi melalui environment)`);else console.log(`Login admin sementara: ${ADMIN_USER} / ${ADMIN_PASSWORD} (atur ADMIN_PASSWORD untuk kata sandi tetap)`);});

// Scheduler only processes explicitly enabled public metadata connectors.
setInterval(async()=>{try{const db=await dbPromise;if(!db.settings.scheduleEnabled)return;for(const c of db.connectors.filter(x=>['demo-source','public-feed','kiryuu'].includes(x.id)&&x.enabled)){const due=!c.lastSync||Date.now()-Date.parse(c.lastSync)>=c.intervalMinutes*60000;if(due)await syncConnector(c.id);}}catch(e){console.error('[scheduler]',e.message);}},60_000).unref();
