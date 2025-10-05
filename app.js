// ---------- globals ----------
let DATA, map, stationById = {}, markers = {}, pathLayers = [];
const lineColors = {
  "Orange":"#ff8c00",
  "Blue":"#1e90ff",
  "Red":"#ff4d4f",
  "Yellow":"#f4d03f",
  "Default":"#111"
};

// ---------- boot ----------
fetch('stations.json').then(r=>r.json()).then(json=>{
  DATA = json;
  DATA.stations.forEach(s => stationById[s.id] = s);
  initUI();
  initMap();
  fillDatalist(DATA.stations);
  tryAutoRouteFromURL();
});

// ---------- UI ----------
function initUI(){
  document.getElementById('btn').addEventListener('click', onFind);
  document.getElementById('share').addEventListener('click', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const sId = findStationIdByName(document.getElementById('src').value);
    const dId = findStationIdByName(document.getElementById('dst').value);
    if (!sId || !dId) return alert('Select valid stations first.');
    setURLParams(sId, dId, mode);
    navigator.clipboard?.writeText(location.href);
    alert('Shareable link copied!');
  });
}

function swapStations() {
  const a = document.getElementById('src');
  const b = document.getElementById('dst');
  [a.value, b.value] = [b.value, a.value];
  const sId = findStationIdByName(a.value);
  const dId = findStationIdByName(b.value);
  if (sId && dId && sId !== dId) onFind();
}

function fillDatalist(stations){
  const dl = document.getElementById('stations');
  dl.innerHTML = stations.map(s=>`<option value="${s.name}">`).join('');
}

// ---------- map ----------
function initMap(){
  const kanpur = [26.47, 80.32];
  map = L.map('map').setView(kanpur, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  // stations
  for (const s of DATA.stations) {
    const m = L.circleMarker([s.lat, s.lng], { radius: 5, color:"#333", weight:2, fillOpacity:0.9 }).addTo(map);
    m.bindTooltip(`${s.name} (${s.line})`);
    markers[s.id] = m;
  }

  // faint network lines
  for (const e of DATA.edges) {
    const a = stationById[e.from], b = stationById[e.to];
    L.polyline([[a.lat,a.lng],[b.lat,b.lng]], {
      opacity:0.2, weight:4, color: lineColors[e.line] || "#888"
    }).addTo(map);
  }
}

function clearPathLayers(){ pathLayers.forEach(p=>map.removeLayer(p)); pathLayers=[]; }

function drawColoredPath(path){
  clearPathLayers();
  if (!path || path.length < 2) return;

  let segment = [ path[0] ], curLine = path[1].line;
  for (let i=1;i<path.length;i++){
    const node = path[i];
    if (node.line !== curLine){
      addSeg(segment, curLine);
      segment = [ path[i-1], node ];
      curLine = node.line;
    } else {
      segment.push(node);
    }
  }
  addSeg(segment, curLine);

  function addSeg(nodes, line){
    const latlngs = nodes.map(p => [stationById[p.id].lat, stationById[p.id].lng]);
    const poly = L.polyline(latlngs, {weight:6, opacity:0.95, color: lineColors[line] || lineColors.Default}).addTo(map);
    pathLayers.push(poly);
  }

  const all = pathLayers.reduce((acc,l)=>acc.concat(l.getLatLngs()),[]);
  const bounds = L.latLngBounds(all);
  map.fitBounds(bounds, {padding:[40,40]});
}

// ---------- helpers ----------
function findStationIdByName(name){
  const s = DATA.stations.find(x => x.name.toLowerCase() === (name||'').trim().toLowerCase());
  return s ? s.id : null;
}
function findNameById(id){ return stationById[id]?.name || ''; }

function buildGraph(edges){
  const g = new Map();
  for (const e of edges) {
    if (!g.has(e.from)) g.set(e.from, []);
    if (!g.has(e.to)) g.set(e.to, []);
    g.get(e.from).push({ to: e.to, time: e.time, line: e.line });
    g.get(e.to).push({ to: e.from, time: e.time, line: e.line });
  }
  return g;
}

// Dijkstra with penalties
function shortestPath({ graph, source, dest, optimize="time", transferPenalty=0 }){
  const dist = new Map(), prev = new Map(), prevLine = new Map();
  const pq = [];
  for (const k of graph.keys()) dist.set(k, Infinity);
  dist.set(source, 0); pq.push([source, 0]);

  const popMin = () => {
    let mi = 0; for (let i=1;i<pq.length;i++) if (pq[i][1] < pq[mi][1]) mi = i;
    return pq.splice(mi,1)[0];
  };

  while (pq.length){
    const [u, d] = popMin();
    if (u === dest) break;
    if (d !== dist.get(u)) continue;

    const uLine = prevLine.get(u) || null;
    for (const {to:v, time, line} of graph.get(u)){
      let w = time;
      if (optimize === 'time' && u !== source && uLine && uLine !== line) w += transferPenalty;
      if (optimize === 'transfers' && u !== source && uLine && uLine !== line) w += 1000; // discourage transfers strongly
      const nd = d + w;
      if (nd < dist.get(v)){
        dist.set(v, nd); prev.set(v, {u, line}); prevLine.set(v, line); pq.push([v, nd]);
      }
    }
  }

  if (dist.get(dest) === Infinity) return null;

  const path = [];
  let cur = dest;
  while (cur){
    const p = prev.get(cur);
    path.push({ id: cur, line: p?.line || null });
    cur = p?.u;
  }
  path.reverse();

  const minutes = Math.round(dist.get(dest));
  const transfers = path.reduce((t,_,i,arr)=>{
    if (i===0) return t;
    const a = arr[i-1].line, b = arr[i].line;
    return (a && b && a !== b) ? t+1 : t;
  },0);

  return { path, minutes, transfers };
}

function computeFare(minutes, table){
  for (const f of table) if (minutes <= f.upToMinutes) return f.price;
  return table.at(-1).price;
}

function toDirections(path){
  if (!path || path.length < 2) return [];
  const steps = [];
  let curLine = path[1].line, start = path[0].id;
  for (let i=1;i<path.length;i++){
    const seg = path[i];
    if (seg.line !== curLine){
      steps.push(`Take ${curLine} from ${findNameById(start)} to ${findNameById(path[i-1].id)}.`);
      steps.push(`Change to ${seg.line} at ${findNameById(path[i-1].id)}.`);
      start = path[i-1].id; curLine = seg.line;
    }
  }
  steps.push(`Continue on ${curLine} to ${findNameById(path.at(-1).id)}.`);
  return steps;
}

// URL params <-> UI
function setURLParams(sId, dId, mode){
  const u = new URL(location.href);
  u.searchParams.set('from', sId);
  u.searchParams.set('to', dId);
  u.searchParams.set('mode', mode);
  history.replaceState(null, '', u.toString());
}
function tryAutoRouteFromURL(){
  const u = new URL(location.href);
  const from = u.searchParams.get('from');
  const to   = u.searchParams.get('to');
  const mode = u.searchParams.get('mode') || 'time';
  if (from && to && stationById[from] && stationById[to]){
    document.getElementById('src').value = findNameById(from);
    document.getElementById('dst').value = findNameById(to);
    document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    onFind();
  }
}

// ---------- action ----------
function onFind(){
  const srcName = document.getElementById('src').value;
  const dstName = document.getElementById('dst').value;
  const mode = document.querySelector('input[name="mode"]:checked').value;

  const sId = findStationIdByName(srcName);
  const dId = findStationIdByName(dstName);
  if (!sId || !dId || sId === dId) {
    alert('Pick valid, different stations from the list.');
    return;
  }

  const g = buildGraph(DATA.edges);
  const res = shortestPath({
    graph: g,
    source: sId,
    dest: dId,
    optimize: mode,
    transferPenalty: DATA.transferPenaltyMinutes
  });
  if (!res){ alert('No route found'); return; }

  const fare = computeFare(res.minutes, DATA.fares);
  const steps = toDirections(res.path);

  // summary
  const sum = document.getElementById('summary');
  sum.classList.remove('hidden');
  sum.innerHTML = `
    <b>Time:</b> ${res.minutes} min &nbsp; • &nbsp;
    <b>Transfers:</b> ${res.transfers} &nbsp; • &nbsp;
    <b>Fare:</b> ₹${fare}
  `;

  // steps
  const st = document.getElementById('steps');
  st.classList.remove('hidden');
  st.innerHTML = '<ol>' + steps.map(s=>`<li>${s}</li>`).join('') + '</ol>';

  // map
  drawColoredPath(res.path);

  // share state
  setURLParams(sId, dId, mode);
}
