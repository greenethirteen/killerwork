const params = new URLSearchParams(location.search);
const jobId = params.get('job');
const pageList = document.getElementById('pageList');
const titleInput = document.getElementById('titleInput');
const pagePreview = document.getElementById('pagePreview');
const savePage = document.getElementById('savePage');
const statusBox = document.getElementById('editorStatus');
const blockEditor = document.getElementById('blockEditor');

let currentSlug = '';
let currentPage = null;

function setStatus(text, tone = '') {
  statusBox.textContent = text;
  statusBox.dataset.tone = tone;
}

function mediaLabel(item) {
  if (item.type === 'image') return `Image ${item.imageIndex + 1}`;
  if (item.type === 'video') return `Video ${item.videoIndex + 1}`;
  if (item.type === 'document') return `PDF ${item.documentIndex + 1}`;
  if (item.type === 'gallery') return `Slider (${item.imageIndexes.length} images)`;
  return 'Text';
}

function makeTextBlock(text = '') {
  return { type: 'text', order: 0, tag: 'p', text };
}

function renderBlocks() {
  blockEditor.innerHTML = '';
  if (!currentPage) return;
  currentPage.contentItems.forEach((item, index) => {
    const row = document.createElement('article');
    row.className = `edit-block ${item.type}`;
    row.dataset.index = index;

    const top = document.createElement('div');
    top.className = 'edit-block-top';
    top.innerHTML = `<b>${mediaLabel(item)}</b>`;

    const controls = document.createElement('div');
    controls.className = 'edit-block-controls';
    const addAfter = document.createElement('button');
    addAfter.type = 'button';
    addAfter.className = 'mini-button';
    addAfter.textContent = 'Add caption below';
    addAfter.addEventListener('click', () => {
      currentPage.contentItems.splice(index + 1, 0, makeTextBlock(''));
      renderBlocks();
    });
    controls.appendChild(addAfter);

    if (item.type === 'text') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-button danger';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        currentPage.contentItems.splice(index, 1);
        renderBlocks();
      });
      controls.appendChild(remove);
    }

    top.appendChild(controls);
    row.appendChild(top);

    if (item.type === 'text') {
      const area = document.createElement('textarea');
      area.value = item.text || '';
      area.placeholder = 'Caption or campaign text';
      area.addEventListener('input', () => { item.text = area.value; });
      row.appendChild(area);
    } else {
      const meta = document.createElement('div');
      meta.className = 'media-readonly';
      if (item.type === 'image') {
        const img = currentPage.images[item.imageIndex];
        meta.textContent = img?.localFile || img?.original || 'Image';
      } else if (item.type === 'video') {
        const video = currentPage.videos[item.videoIndex];
        meta.textContent = video?.original || video?.src || 'Video';
      } else if (item.type === 'document') {
        const document = currentPage.documents[item.documentIndex];
        meta.textContent = document?.original || document?.src || 'PDF';
      } else {
        meta.textContent = item.imageIndexes.map(i => currentPage.images[i]?.localFile || `image ${i + 1}`).join(', ');
      }
      row.appendChild(meta);
    }

    blockEditor.appendChild(row);
  });
}

async function loadPage(slug) {
  currentSlug = slug;
  setStatus('Loading page...');
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(slug)}`);
  currentPage = await res.json();
  if (!res.ok) {
    setStatus(currentPage.error || 'Could not load page.', 'error');
    return;
  }
  titleInput.value = currentPage.title || '';
  pagePreview.href = `/generated/${jobId}/site/work/${currentPage.slug}/index.html`;
  [...pageList.querySelectorAll('button')].forEach(btn => btn.classList.toggle('active', btn.dataset.slug === slug));
  renderBlocks();
  setStatus('Edits are local until you save.');
}

async function loadPages() {
  if (!jobId) {
    setStatus('Missing job id. Open this from a completed import.', 'error');
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages`);
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Could not load import.', 'error');
    return;
  }
  pageList.innerHTML = '';
  data.pages.forEach(page => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.slug = page.slug;
    btn.textContent = page.title;
    btn.addEventListener('click', () => loadPage(page.slug));
    pageList.appendChild(btn);
  });
  if (data.pages[0]) loadPage(data.pages[0].slug);
}

savePage.addEventListener('click', async () => {
  if (!currentPage) return;
  savePage.disabled = true;
  savePage.textContent = 'Saving...';
  setStatus('Saving and rebuilding preview/ZIP...');
  const body = {
    title: titleInput.value,
    contentItems: currentPage.contentItems.map((item, idx) => ({ ...item, order: idx + 1 }))
  };
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  savePage.disabled = false;
  savePage.textContent = 'Save page';
  if (!res.ok) {
    setStatus(data.error || 'Save failed.', 'error');
    return;
  }
  currentPage = data.page;
  titleInput.value = currentPage.title;
  pagePreview.href = data.preview;
  renderBlocks();
  setStatus(data.validation?.ok ? 'Saved. Preview and ZIP rebuilt.' : 'Saved with validation warnings.', data.validation?.ok ? 'ok' : 'warn');
});

loadPages();
