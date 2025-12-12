import { saveState, loadState, saveChunk, loadChunk, clearDB } from './storage.js';

// --- إعدادات وتوابت ---
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_CONCURRENCY = 2; // أمان أكثر لتجنب الحظر
const CHUNK_SIZE = 14000;  // حجم مناسب لـ Flash
const MAX_RETRIES = 5;

// --- عناصر الواجهة ---
const qs = s => document.querySelector(s);
const logBox = qs('#logBox');
const progressBar = qs('#progressBar');
const progressText = qs('#progressText');
const startBtn = qs('#startButton');
const downloadLink = qs('#downloadLink');

let apiKeys = [];
let currentKeyIdx = 0;
let fileFile = null;

// --- أدوات مساعدة ---
function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString('en-GB')}] ${msg}`;
  logBox.prepend(div);
}

function updateProgress(percent, text) {
  progressBar.style.width = `${percent}%`;
  if(text) progressText.textContent = text;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getApiKey() {
  const k = apiKeys[currentKeyIdx];
  currentKeyIdx = (currentKeyIdx + 1) % apiKeys.length;
  return k;
}

// --- الاتصال بـ Gemini ---
async function translateWithGemini(text, model) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const key = getApiKey();
    try {
      const res = await fetch(`${API_URL}/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `
            أنت مترجم روائي محترف.
            المهمة: ترجمة النص التالي من رواية إنجليزية إلى العربية الفصحى السردية.
            القواعد الصارمة:
            1. لا تترجم وسوم HTML (مثل <p>, <div>, class, id) أبداً.
            2. حافظ على هيكلية النص تماماً.
            3. لا تضف مقدمات أو شروحات. فقط النص المترجم.
            4. إذا وجدت نصاً غير مفهوم أو رموزاً غريبة، اتركها كما هي.
            
            النص:
            ${text}
          `}]}],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        })
      });

      if (res.status === 429) {
        log(`⚠️ الحد الأقصى للمفتاح، تبديل...`, 'warn');
        await sleep(1000);
        continue;
      }
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || res.statusText);
      
      let translated = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!translated) throw new Error('رد فارغ من النموذج');
      
      // تنظيف الرد من علامات Markdown المحتملة
      translated = translated.replace(/^```html/i, '').replace(/^```xml/i, '').replace(/```$/, '').trim();
      return translated;

    } catch (e) {
      log(`خطأ في الاتصال (محاولة ${i+1}): ${e.message}`, 'err');
      await sleep(2000);
    }
  }
  return text; // في حال الفشل التام، أعد النص الأصلي
}

// --- معالجة EPUB (الجزء الأهم لملفك) ---
async function parseEpub(file) {
  log('📂 جاري فك ضغط الملف...', 'info');
  const zip = await JSZip.loadAsync(file);
  
  // 1. البحث عن ملف container.xml لتحديد مكان OPF بدقة
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("ملف EPUB غير صالح (مفقود container.xml)");
  
  const containerXml = await containerFile.async("text");
  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, "application/xml");
  
  // الحصول على المسار الكامل لملف OPF
  // مثال: قد يكون "EPUB/BacktotheSixties.opf"
  let opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
  log(`📍 ملف OPF موجود في: ${opfPath}`);
  
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error("لم يتم العثور على ملف OPF في المسار المحدد");
  
  const opfXml = await opfFile.async("text");
  const opfDoc = parser.parseFromString(opfXml, "application/xml");
  
  // تحديد المجلد الأساسي (Base Directory) للمحتوى
  // إذا كان opfPath = "EPUB/file.opf"، فإن القاعدة هي "EPUB/"
  const baseDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // استخراج قائمة الملفات (Spine)
  const manifest = {};
  opfDoc.querySelectorAll("manifest > item").forEach(item => {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  });

  const chapters = [];
  opfDoc.querySelectorAll("spine > itemref").forEach(ref => {
    const id = ref.getAttribute("idref");
    const href = manifest[id];
    if (href) {
      // دمج المسار الأساسي مع مسار الملف النسبي
      // مثال: baseDir="EPUB/", href="content/Chapter1.xhtml" -> "EPUB/content/Chapter1.xhtml"
      const fullPath = baseDir + href;
      
      // التأكد من أن الملف نصي (HTML/XHTML)
      if (fullPath.match(/\.(html|xhtml|htm|xml)$/i)) {
        chapters.push({ fullPath, href }); // نحتفظ بـ href الأصلي أيضاً
      }
    }
  });

  log(`✅ تم العثور على ${chapters.length} فصل.`);
  return { zip, chapters, baseDir };
}

// --- تقسيم النص وجمعه ---
function splitHtml(html) {
  // استخراج الـ Body فقط للحفاظ على الـ Head والأنماط
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "application/xhtml+xml"); // استخدام XHTML لأن EPUB عادة XML
  const body = doc.body;
  
  if (!body) return { chunks: [html], isFull: true }; // إذا لم نجد body، نترجم الملف كله

  const originalBodyHtml = body.innerHTML;
  
  // تقسيم ذكي جداً: نقسم عند إغلاق الفقرات لتجنب كسر الوسوم
  // نبحث عن </p> أو </div> متبوعة بمسافة
  const regex = /(?<=<\/p>|<\/div>|<\/h[1-6]>)\s+/gi;
  const rawParts = originalBodyHtml.split(regex);
  
  const chunks = [];
  let buffer = "";
  
  for (const part of rawParts) {
    if ((buffer.length + part.length) > CHUNK_SIZE) {
      chunks.push(buffer);
      buffer = "";
    }
    buffer += part + " ";
  }
  if (buffer.trim()) chunks.push(buffer);
  
  return { chunks, doc, isFull: false };
}

// --- العمليات الرئيسية ---
startBtn.addEventListener('click', async () => {
  const keysText = qs('#apiKeys').value.trim();
  if (!keysText) return alert('الرجاء إدخال مفاتيح API');
  apiKeys = keysText.split('\n').map(k => k.trim()).filter(k => k);
  
  const fileInput = qs('#epubFile');
  if (!fileInput.files[0]) return alert('الرجاء اختيار ملف');
  
  startBtn.disabled = true;
  downloadLink.style.display = 'none';
  
  try {
    const model = qs('#modelSelect').value;
    const { zip, chapters } = await parseEpub(fileInput.files[0]);
    
    // استعادة التقدم
    const state = await loadState();
    let startIdx = 0;
    if (state && state.fileName === fileInput.files[0].name) {
      startIdx = state.chapterIdx || 0;
      log(`⏩ استئناف من الفصل ${startIdx + 1}`);
    }

    // حلقة الفصول
    for (let i = startIdx; i < chapters.length; i++) {
      const chapter = chapters[i];
      const percent = Math.round(((i) / chapters.length) * 100);
      updateProgress(percent, `ترجمة الفصل ${i+1}/${chapters.length}: ${chapter.href}`);
      
      const fileData = await zip.file(chapter.fullPath).async("text");
      const { chunks, doc, isFull } = splitHtml(fileData);
      
      const translatedChunks = [];
      
      // معالجة الأجزاء (Chunks) بالتوازي المحدود
      // نستخدم الحلقات للتحكم في التزامن يدوياً
      for (let j = 0; j < chunks.length; j += MAX_CONCURRENCY) {
        const batch = chunks.slice(j, j + MAX_CONCURRENCY);
        const promises = batch.map(async (chunk, batchIdx) => {
          const chunkGlobalIdx = j + batchIdx;
          const chunkKey = `${chapter.fullPath}_chk_${chunkGlobalIdx}`;
          
          // التحقق من الذاكرة
          const cached = await loadChunk(chunkKey);
          if (cached) return cached;
          
          // الترجمة
          const trans = await translateWithGemini(chunk, model);
          await saveChunk(chunkKey, trans);
          return trans;
        });
        
        const results = await Promise.all(promises);
        translatedChunks.push(...results);
      }
      
      // إعادة تجميع الفصل
      let finalHtml;
      if (isFull) {
        finalHtml = translatedChunks.join(' ');
      } else {
        // حقن الترجمة داخل الـ Body
        doc.body.innerHTML = translatedChunks.join(' ');
        doc.documentElement.setAttribute('dir', 'rtl'); // تعريب الاتجاه
        doc.documentElement.setAttribute('lang', 'ar');
        const serializer = new XMLSerializer();
        finalHtml = serializer.serializeToString(doc);
      }
      
      // تحديث الملف داخل الـ ZIP
      zip.file(chapter.fullPath, finalHtml);
      
      // حفظ التقدم
      await saveState({ fileName: fileInput.files[0].name, chapterIdx: i + 1 });
    }

    updateProgress(100, "جاري تحضير الملف النهائي...");
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    
    downloadLink.href = url;
    downloadLink.download = fileInput.files[0].name.replace('.epub', '_AR.epub');
    downloadLink.style.display = 'block';
    log('🎉 تمت المهمة بنجاح!', 'ok');

  } catch (e) {
    log(`خطأ قاتل: ${e.message}`, 'err');
    console.error(e);
  } finally {
    startBtn.disabled = false;
  }
});

qs('#clearButton').addEventListener('click', async () => {
  if (confirm('هل أنت متأكد؟')) {
    await clearDB();
    location.reload();
  }
});
