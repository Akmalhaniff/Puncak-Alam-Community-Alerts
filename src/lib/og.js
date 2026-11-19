// Link previews (WhatsApp, Telegram, Facebook): page title, description and image as meta tags.
// WhatsApp reads these from the HTML the server sends, so they're filled in on the server.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SITE_TITLE = 'Amaran Banjir Puncak Alam';
const SITE_DESC = 'Peta laporan banjir dan jalan dari penduduk Puncak Alam. Nampak banjir? Laporkan di sini.';
const STATUS = { danger: '⚠️ Banjir', uncertain: '⚠️ Belum pasti', clear: '✅ Dah surut' };
const LEVEL = { ankle: 'paras buku lali', knee: 'paras lutut', waist: 'paras pinggang', car: 'kereta tenggelam' };

function fmtTime(date) {
  return new Date(date).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// report: a row from the reports list (or null for the home page). origin: e.g. "https://example.com".
export function previewFor(report, origin) {
  if (!report) {
    return { title: SITE_TITLE, description: SITE_DESC, image: `${origin}/icons/og-image.png`, url: `${origin}/`, imageWide: true };
  }
  const level = report.waterLevel ? ` · ${LEVEL[report.waterLevel]}` : '';
  return {
    title: `${STATUS[report.status] || 'Laporan'}: ${report.area}${level}`,
    description: `${fmtTime(report.time)} · ${report.details}`.slice(0, 200),
    image: report.hasPhoto ? `${origin}/api/reports/${report.id}/photo?size=full` : `${origin}/icons/og-image.png`,
    url: `${origin}/?r=${report.id}`,
    imageWide: !report.hasPhoto,
  };
}

export function metaTags(p) {
  return [
    `<meta name="description" content="${esc(p.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE_TITLE)}" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    `<meta property="og:url" content="${esc(p.url)}" />`,
    `<meta property="og:image" content="${esc(p.image)}" />`,
    p.imageWide ? `<meta property="og:image:width" content="1200" />\n  <meta property="og:image:height" content="630" />` : '',
    `<meta property="og:locale" content="ms_MY" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].filter(Boolean).join('\n  ');
}
