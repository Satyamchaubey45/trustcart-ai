require('dotenv').config();
const express = require('express'), path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const W = { sentiment: 25, credibility: 20, distribution: 15, complaints: 15, consistency: 10, price: 5, sales: 10 };

function finish(base, comp) {
  let sw = 0, aw = 0, sc = 0;
  for (const k in W) { sw += W[k]; if (comp[k] != null) aw += W[k]; }
  for (const k in W) if (comp[k] != null) sc += comp[k] * W[k] / aw;
  sc = Math.round(sc);
  const rec = sc >= 75 ? ['RECOMMENDED', '#12a36b'] : sc >= 40 ? ['BUY WITH CAUTION', '#e59a0b'] : ['NOT RECOMMENDED', '#e5484d'];
  const cat = sc >= 90 ? 'Excellent Trust Indicators' : sc >= 75 ? 'Good Trust Indicators' : sc >= 60 ? 'Moderate Trust Indicators' : sc >= 40 ? 'High Caution' : 'Very High Risk Signals';
  return { ...base, comp, sc, conf: Math.round(aw / sw * 100), rec, cat };
}

async function amazon(url, u) {
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) throw new Error('RAINFOREST_API_KEY .env mein set nahi hai.');
  const m = u.pathname.match(/(?:dp|product|d)\/([A-Z0-9]{10})/i);
  if (!m) throw new Error('Link mein ASIN nahi mila. Product page ka link (…/dp/XXXXXXXXXX) daalein.');
  const qs = new URLSearchParams({ api_key: key, type: 'product', amazon_domain: u.hostname.replace(/^www\./, ''), asin: m[1] });
  const r = await fetch('https://api.rainforestapi.com/request?' + qs);
  const j = await r.json();
  if (!j.request_info || !j.request_info.success) throw new Error((j.request_info && j.request_info.message) || 'Provider error');
  const p = j.product || {};
  const bb = p.buybox_winner || {};
  const cur = bb.price && bb.price.value, orig = bb.rrp && bb.rrp.value;
  const rb = p.rating_breakdown;
  const d = rb ? [rb.five_star, rb.four_star, rb.three_star, rb.two_star, rb.one_star].map(x => Math.round((x && x.percentage) || 0)) : null;
  const revs = p.top_reviews || [];
  const pos = d ? d[0] + d[1] : null, neg = d ? d[3] + d[4] : null, neu = d ? d[2] : null;

  // Credibility: sirf wahi jo review sample se nikal sakte hain
  let cred = null; const sig = [];
  if (revs.length >= 5) {
    const bodies = revs.map(r => (r.body || '').toLowerCase().slice(0, 60));
    const dup = 1 - new Set(bodies).size / bodies.length;
    const ver = revs.filter(r => r.verified_purchase).length / revs.length;
    sig.push(['Repetitive review language (sample)', dup > .2 ? 'High' : dup > .05 ? 'Medium' : 'Low']);
    sig.push(['Verified-purchase share (sample)', ver < .5 ? 'High' : ver < .8 ? 'Medium' : 'Low']);
    cred = Math.round(100 - dup * 150 - (1 - ver) * 40);
  }
  const disc = cur && orig && orig > cur ? Math.round((1 - cur / orig) * 100) : 0;
  const comp = {
    sentiment: pos, credibility: cred == null ? null : Math.max(0, cred),
    distribution: d ? (d[4] > d[3] + d[2] ? 50 : 85) : null,
    complaints: neg == null ? null : Math.max(0, 100 - neg * 2.2),
    consistency: null,
    price: cur ? (disc > 70 ? 40 : disc >= 10 ? 80 : 60) : null,
    sales: null
  };
  const base = {
    pf: 'Amazon', url, demo: false, name: p.title || 'Data Unavailable', brand: p.brand || 'Data Unavailable',
    cur: cur || 0, orig: orig || cur || 0, disc, rating: p.rating || 0, count: p.ratings_total || 0,
    d: d || [0, 0, 0, 0, 0], pos: pos || 0, neg: neg || 0, neu: neu || 0, hist: [], sig,
    sales: p.recent_sales || null,
    pros: [p.top_positive && p.top_positive.title].filter(Boolean),
    cons: [p.top_critical && p.top_critical.title].filter(Boolean)
  };
  if (!base.pros.length) base.pros = ['Data Unavailable'];
  if (!base.cons.length) base.cons = ['Data Unavailable'];
  return finish(base, comp);
}

const PF = { amazon: 'Amazon', flipkart: 'Flipkart', myntra: 'Myntra', meesho: 'Meesho', ajio: 'Ajio' };
function walk(o, out) {
  if (Array.isArray(o)) o.forEach(x => walk(x, out));
  else if (o && typeof o === 'object') { if ([].concat(o['@type'] || []).includes('Product')) out.push(o); walk(o['@graph'], out); }
}
async function generic(url, u) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) throw new Error('SCRAPER_API_KEY .env mein set nahi hai (Amazon ke alawa sabhi sites ke liye zaroori).');
  const tpl = process.env.SCRAPER_ENDPOINT || 'https://app.scrapingbee.com/api/v1/?api_key={key}&render_js=true&url={url}';
  const r = await fetch(tpl.replace('{key}', encodeURIComponent(key)).replace('{url}', encodeURIComponent(url)));
  if (!r.ok) throw new Error('Scraper provider error ' + r.status + ': key/credits check karein, ya site ne page block kiya ho sakta hai.');
  const html = await r.text();
  const prods = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1]), prods); } catch (e) {} }
  const p = prods[0] || {};
  const meta = n => { const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]+content=["\']([^"\']*)["\']', 'i')); return m && m[1]; };
  const o = [].concat(p.offers || [])[0] || {};
  const cur = +(o.price || o.lowPrice || meta('product:price:amount')) || 0;
  const name = p.name || meta('og:title') || '';
  if (!name && !cur) throw new Error('Is page se product data nahi mila. Site ne block kiya ho ya page structure alag hai.');
  const ar = p.aggregateRating || {};
  const revs = [].concat(p.review || []);
  const stars = revs.map(r => +(r.reviewRating && r.reviewRating.ratingValue)).filter(Boolean);
  let d = null, pos = null, neg = null, neu = null;
  if (stars.length >= 3) {
    const n = stars.length; d = [5, 4, 3, 2, 1].map(s => Math.round(stars.filter(x => Math.round(x) === s).length / n * 100));
    pos = d[0] + d[1]; neg = d[3] + d[4]; neu = d[2];
  }
  let cred = null; const sig = [];
  if (revs.length >= 5) {
    const bodies = revs.map(r => String(r.reviewBody || r.description || '').toLowerCase().slice(0, 60));
    const dup = 1 - new Set(bodies).size / bodies.length;
    sig.push(['Repetitive review language (sample)', dup > .2 ? 'High' : dup > .05 ? 'Medium' : 'Low']);
    cred = Math.max(0, Math.round(100 - dup * 150));
  }
  const comp = {
    sentiment: pos, credibility: cred, distribution: d ? (d[4] > d[3] + d[2] ? 50 : 85) : null,
    complaints: neg == null ? null : Math.max(0, 100 - neg * 2.2), consistency: null, price: cur ? 60 : null, sales: null
  };
  const best = revs.filter(r => r.name).sort((a, b) => (+(b.reviewRating && b.reviewRating.ratingValue) || 0) - (+(a.reviewRating && a.reviewRating.ratingValue) || 0));
  const host = u.hostname.toLowerCase();
  const base = {
    pf: Object.keys(PF).filter(k => host.includes(k)).map(k => PF[k])[0] || u.hostname, url, demo: false, name: name || 'Data Unavailable',
    brand: (typeof p.brand === 'string' ? p.brand : p.brand && p.brand.name) || 'Data Unavailable',
    cur, orig: cur, disc: 0, rating: +ar.ratingValue || 0, count: +(ar.ratingCount || ar.reviewCount) || 0,
    d: d || [0, 0, 0, 0, 0], pos: pos || 0, neg: neg || 0, neu: neu || 0, hist: [], sig, sales: null,
    pros: best.length ? [best[0].name] : ['Data Unavailable'], cons: best.length > 1 && (+(best[best.length - 1].reviewRating && best[best.length - 1].reviewRating.ratingValue) || 5) <= 2 ? [best[best.length - 1].name] : ['Data Unavailable']
  };
  return finish(base, comp);
}

app.post('/api/analyze', async (req, res) => {
  try {
    let url = String((req.body || {}).url || '').trim();
    let u; try { u = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    // Short links (amzn.in, amzn.to, a.co): sirf redirect follow karte hain
    for (let i = 0; i < 4 && /^(www\.)?(amzn\.(in|to|eu|com)|a\.co)$/i.test(u.hostname); i++) {
      const r = await fetch(u.href, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      const loc = r.headers.get('location');
      if (!loc) break;
      u = new URL(loc, u); url = u.href;
    }
    if (/amazon\./i.test(u.hostname) && process.env.RAINFOREST_API_KEY) return res.json(await amazon(url, u));
    return res.json(await generic(url, u));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log('TrustCart AI running on port ' + (process.env.PORT || 3000)));
