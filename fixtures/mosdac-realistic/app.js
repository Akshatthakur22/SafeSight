(function () {
  'use strict';
  const data = window.MOSDAC_DATA;
  const qs = new URLSearchParams(location.search);
  const byId = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));

  document.querySelectorAll('[data-user]').forEach(el => {
    const key = el.dataset.user;
    if (data.user[key]) el.textContent = data.user[key];
  });

  function datasetCard(item) {
    return `<article class="card"><div class="eyebrow">${esc(item.category)} / ${esc(item.mission)}</div><h3><a href="dataset.html?id=${encodeURIComponent(item.id)}">${esc(item.title)}</a></h3><p>${esc(item.description)}</p><p><span class="badge ${item.status === 'Processing' ? 'amber' : ''}">${esc(item.status)}</span> <span class="badge blue">${esc(item.format)}</span></p><a class="button secondary" href="dataset.html?id=${encodeURIComponent(item.id)}">View dataset</a></article>`;
  }

  window.datasetCard = datasetCard;

  function renderRows(items) {
    const body = byId('results-body');
    if (!body) return;
    body.innerHTML = items.length ? items.map(item => `<tr><td><a href="dataset.html?id=${encodeURIComponent(item.id)}"><strong>${esc(item.id)}</strong></a><br><span style="color:#607789">${esc(item.title)}</span></td><td>${esc(item.mission)}<br>${esc(item.category)}</td><td>${esc(item.date)}</td><td>${esc(item.format)}</td><td>${esc(item.size)}</td><td><span class="badge ${item.status === 'Processing' ? 'amber' : ''}">${esc(item.status)}</span></td><td><a class="button secondary" href="dataset.html?id=${encodeURIComponent(item.id)}">Details</a></td></tr>`).join('') : '<tr><td colspan="7" class="empty">No datasets matched the current filters.</td></tr>';
    const count = byId('result-count'); if (count) count.textContent = `${items.length} dataset${items.length === 1 ? '' : 's'} found`;
  }

  function runSearch() {
    const query = (byId('query')?.value || '').trim().toLowerCase();
    const mission = byId('mission')?.value || '';
    const category = byId('category')?.value || '';
    const results = data.datasets.filter(item => {
      const haystack = [item.id,item.title,item.description,item.mission,item.category,...item.tags].join(' ').toLowerCase();
      return (!query || haystack.includes(query)) && (!mission || item.mission === mission) && (!category || item.category === category);
    });
    renderRows(results);
    const status = byId('search-status'); if (status) status.textContent = `Search completed locally at ${new Date(0).toISOString().slice(0,10)}. ${results.length} deterministic result(s).`;
  }

  if (byId('search-form')) { byId('search-form').addEventListener('submit', e => { e.preventDefault(); runSearch(); }); byId('reset-search')?.addEventListener('click', () => { byId('search-form').reset(); runSearch(); }); runSearch(); }

  const dataset = data.datasets.find(item => item.id === qs.get('id'));
  if (byId('dataset-detail')) {
    if (!dataset) { byId('dataset-detail').innerHTML = '<div class="card"><h2>Dataset not found</h2><p>Choose a dataset from the <a href="datasets.html">catalog</a>.</p></div>'; }
    else {
      byId('dataset-detail').innerHTML = `<div class="card"><div class="detail-head"><div><div class="eyebrow">${esc(dataset.category)} / ${esc(dataset.mission)}</div><h2>${esc(dataset.title)}</h2><p>${esc(dataset.description)}</p></div><span class="badge ${dataset.status === 'Processing' ? 'amber' : ''}">${esc(dataset.status)}</span></div><div class="meta-list"><div><b>Dataset identifier</b>${esc(dataset.id)}</div><div><b>Acquisition date</b>${esc(dataset.date)}</div><div><b>Coverage</b>${esc(dataset.coverage)}</div><div><b>File format</b>${esc(dataset.format)} · ${esc(dataset.size)}</div></div><div class="notice">Local demonstration record. No network request is made by this download action.</div><p style="margin-top:18px"><button id="download-dataset" class="button success">Download ${esc(dataset.format)} file</button> <a class="button secondary" href="datasets.html">Back to catalog</a></p><div id="download-status" class="status" role="status"></div></div>`;
      byId('download-dataset').addEventListener('click', () => { const blob = new Blob([`MOSDAC LOCAL DATASET\\nID: ${dataset.id}\\nTITLE: ${dataset.title}\\nDATE: ${dataset.date}\\nFORMAT: ${dataset.format}\\n`], {type:'text/plain'}); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${dataset.id}.txt`; link.click(); URL.revokeObjectURL(link.href); byId('download-status').textContent = `Download queued locally for ${dataset.id}.`; });
    }
  }

  if (byId('profile-form')) { byId('profile-form').addEventListener('submit', e => { e.preventDefault(); byId('profile-status').textContent = 'Synthetic profile changes saved locally for this page session.'; }); }
})();
