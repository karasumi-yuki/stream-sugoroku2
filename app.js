'use strict';
/* STREAM SUGOROKU test2 v6.1: Firebase Realtime Database compatibility fix.
 * Firebase can omit empty arrays in stored JSON. Normalize read data before any game operation.
 */
const $ = id => document.getElementById(id);
const role = new URLSearchParams(location.search).get('role') === 'viewer' ? 'viewer' : 'admin';
const CLOUD = !!window.SUGOROKU_FIREBASE_CONFIG;
const ROOM = String(window.SUGOROKU_ROOM_ID || 'demo').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'demo';
const COLORS = ['#ff6c93','#69baff','#ffc76b','#bc92ff','#64e8b6','#ff8d62','#e7a5ef','#a5c9ff','#f0dc74','#85cdd1'];
const DICE = {normal:{label:'通常',cost:100,faces:[1,2,3,4,5,6]},slow:{label:'低速',cost:200,faces:[1,2,3]},fast:{label:'高速',cost:200,faces:[5,6]},select:{label:'指定',cost:500,faces:[1,2,3,4,5,6]}};
const LOCAL_KEY = 'stream-sugoroku-test-v2';
const REQUEST_KEY = 'stream-sugoroku-requests-v2';
// 表示の設定だけを保存します。出目・移動・残高は常に共有のゲーム状態へ保存します。
const DICE_VISUAL_MODE_KEY = 'stream-sugoroku-dice-visual-mode-v1';
let diceVisualMode = localStorageGet(DICE_VISUAL_MODE_KEY) === 'instant' ? 'instant' : 'animated';
const ROLL_SPIN_MS = 1750, ROLL_REVEAL_MS = 750, ROLL_STEP_MS = 370, ROLL_END_MS = 680;
function rollSteps(r){return Math.max(0, Math.min(120,Number(r?.to)-Number(r?.from)||0));}
function rollTotalMs(r){return ROLL_SPIN_MS+ROLL_REVEAL_MS+ROLL_STEP_MS*rollSteps(r)+ROLL_END_MS;}
function isRollActive(r){return !!(r?.id && !r.skipped && Number.isFinite(r.at) && Date.now()-r.at>=-1500 && Date.now()-r.at<rollTotalMs(r));}
function makeRollId(){return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `roll-${Date.now()}-${Math.random().toString(36).slice(2)}`;}

const DEFAULT_EVENT_CELLS = [8,16,24,33,43,51];
const TILE_KIND_LABELS = {normal:'通常',event:'イベント',bonus:'ボーナス',warning:'注意・ペナルティ'};
const TILE_KIND_COLORS = {normal:'#203349',event:'#4c3c65',bonus:'#235747',warning:'#624231'};
function defaultBoard(){return {count:60,cells:Object.fromEntries(DEFAULT_EVENT_CELLS.map(n=>[n.toString(),{kind:'event',title:'イベント',description:''}]))};}
function validBoard(g){const raw=g?.board;const n=Number(raw?.count);return {count:Number.isInteger(n)&&n>=1&&n<=120?n:60,cells:raw && typeof raw==='object' ? (raw.cells && typeof raw.cells==='object' && !Array.isArray(raw.cells) ? raw.cells : {}) : defaultBoard().cells};}
function boardCount(g=doc.game){return validBoard(g).count;}
function tileInfo(n,g=doc.game){const b=validBoard(g),t=b.cells?.[String(n)]||{};return {kind:TILE_KIND_LABELS[t.kind]?t.kind:'normal',title:String(t.title||'').slice(0,18),description:String(t.description||'').slice(0,300)};}
let boardDraft=null,editingTile=1,boardDirty=false,inspectedTile=null;

const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');
let doc = makeDoc(), selectedId = 'p1', selectedDice = 'normal', zoom=1, cloudDB=null, cloudAuth=null, stateRef=null, authorized=!CLOUD, firebaseUser=null;
let pendingRequests={}, cloudRequestsRef=null, masterListRef=null, ownerLoggedIn=false, channel=null, anims = {}, toastTimer;
let lastReceived=null;
const savedViewerId = sessionStorageGet('stream-sugoroku-viewer-id');
const localViewerId = savedViewerId || `viewer-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
sessionStorageSet('stream-sugoroku-viewer-id', localViewerId);
function sessionStorageGet(key){try{return sessionStorage.getItem(key)}catch{return null}}
function sessionStorageSet(key,val){try{sessionStorage.setItem(key,val)}catch{}}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function freshPlayer(id,name,color,pos=1,balance=0){return {id,name,color,pos,balance,totalGift:balance,spent:0,rolls:0,path:[pos],visited:[pos],rollHistory:[]};}
function makeDoc(){return {game:{board:defaultBoard(),players:[freshPlayer('p1','Alice',COLORS[0],1,350),freshPlayer('p2','Bob',COLORS[1],1,500),freshPlayer('p3','Carol',COLORS[2],1,50)],turn:0,lastRoll:null,events:[{text:'テストルームを開始しました',time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}]},past:[],future:[]};}
function clone(x){return JSON.parse(JSON.stringify(x));}
function notice(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3400);}
function now(){return new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});}
function addEvent(g,text){g.events.unshift({text,time:now()});g.events=g.events.slice(0,60);}
function getSelected(){return doc.game.players.find(p=>p.id===selectedId) || doc.game.players[0] || null;}
function canOperate(){if(role!=='admin'){notice('観戦画面から盤面は操作できません');return false;}if(!authorized){notice('管理者ログインが必要です');return false;}return true;}
function safeDocument(candidate){
  // Firebase Realtime Database では空配列が保存後に省略されることがある。
  // プレイヤーのサイコロ履歴、全員削除後の players、巻き戻し履歴を必ず配列へ復元する。
  // 既存のゲーム状態がある場合は初期サンプルデータに戻さず、その状態を維持する。
  const state = candidate && candidate.game && typeof candidate.game === 'object'
    ? clone(candidate) : makeDoc();
  const g = state.game;
  if(!Array.isArray(g.players))g.players=[];
  if(!Array.isArray(g.events))g.events=[];
  if(!Array.isArray(state.past))state.past=[];
  if(!Array.isArray(state.future))state.future=[];
  if(!g.board || typeof g.board!=='object')g.board=defaultBoard();
  if(!g.board.cells || typeof g.board.cells!=='object' || Array.isArray(g.board.cells))g.board.cells={};
  for(const p of g.players){
    if(!Number.isInteger(p.pos))p.pos=1;
    if(!Array.isArray(p.path) || !p.path.length)p.path=[p.pos];
    if(!Array.isArray(p.visited) || !p.visited.length)p.visited=p.path.slice();
    if(!Array.isArray(p.rollHistory))p.rollHistory=[];
  }
  return state;
}
function updateAnimations(previous,next){
  if(!previous||!next)return;
  const rollChanged = next.lastRoll?.id && next.lastRoll.id !== previous.lastRoll?.id;
  const rolledPlayer = rollChanged ? next.lastRoll.playerId : null;
  if(rolledPlayer) delete anims[rolledPlayer];
  const oldP=new Map(previous.players.map(p=>[p.id,p]));
  for(const p of next.players){
    const old=oldP.get(p.id);
    if(old && p.pos !== old.pos && p.id !== rolledPlayer){
      anims[p.id]={from:old.pos,to:p.pos,start:performance.now(),duration:Math.max(400,Math.min(2200,Math.abs(p.pos-old.pos)*320))};
    }
  }
}
function useDoc(next){if(!next)return;const old=doc?.game;doc=safeDocument(next);updateAnimations(old,doc.game);if(!doc.game.players.some(p=>p.id===selectedId))selectedId=doc.game.players[0]?.id||null;renderUI();}
function localWrite(next){localStorageSet(LOCAL_KEY,JSON.stringify(next));useDoc(next);channel?.postMessage({type:'state',doc:next});}
function localStorageGet(key){try{return localStorage.getItem(key)}catch{return null;}}
function localStorageSet(key,value){try{localStorage.setItem(key,value)}catch{}}
async function commit(change,label){if(!canOperate())return false;let failure='';const updateFn=current=>{let next=safeDocument(current);next=clone(next);const before=clone(next.game);const result=change(next.game);if(result===false){failure='操作を実行できませんでした';return;};next.past=[...(next.past||[]),before].slice(-35);next.future=[];return next;};try{if(CLOUD){const result=await stateRef.transaction(updateFn,undefined,false);if(!result.committed){notice(failure||'操作が取り消されました');return false;}}else{const updated=updateFn(doc);if(!updated){notice(failure);return false;}localWrite(updated);}notice(label||'更新しました');return true;}catch(e){console.error(e);notice(`保存できませんでした：${e.message}`);return false;}}
async function historyChange(direction){if(!canOperate())return;if(isRollActive(doc.game.lastRoll)){notice('演出終了後に操作するか、演出スキップを押してください');return;}const updateFn=raw=>{const next=clone(safeDocument(raw));const source=direction==='undo'?'past':'future',target=direction==='undo'?'future':'past';if(!next[source]?.length)return;next[target]=[...(next[target]||[]),clone(next.game)].slice(-35);next.game=next[source].pop();return next;};try{if(CLOUD){const r=await stateRef.transaction(updateFn,undefined,false);if(!r.committed){notice('これ以上戻せません');return;}}else{const next=updateFn(doc);if(!next){notice('これ以上戻せません');return;}localWrite(next);}notice(direction==='undo'?'直前の操作を巻き戻しました':'操作をやり直しました');}catch(e){notice('巻き戻しに失敗しました');console.error(e)}}
function addPlayer(name,id){const tidy=name.trim().slice(0,20);if(!tidy)return Promise.resolve();return commit(g=>{if(g.players.some(p=>p.name===tidy || p.id===id)){return false;}g.players.push(freshPlayer(id||`p${Date.now()}${Math.floor(Math.random()*10000)}`,tidy,COLORS[g.players.length%COLORS.length]));addEvent(g,`👤 ${tidy} が参加しました`);},`${tidy} を追加しました`)}
function renderPlayers(){const box=$('playerList');const query=$('searchPlayer').value.trim().toLowerCase();const players=doc.game.players.filter(p=>p.name.toLowerCase().includes(query));box.innerHTML=players.length?'':'<small class="empty">参加者が見つかりません</small>';for(const player of players){const p=document.createElement('button');p.type='button';p.className='player'+(selectedId===player.id?' selected':'');p.innerHTML=`<span class="avatar" style="background:${player.color}">${escapeHtml(player.name.slice(0,1))}</span><span class="playerbody"><b>${escapeHtml(player.name)}</b><small>${player.balance.toLocaleString()}pt / 🎲${player.rolls}回</small></span><span class="playerposition">${player.pos}マス ›</span>`;p.onclick=()=>{selectedId=player.id;renderUI();};box.appendChild(p);}}
function renderDiceVisualMode(){
  const enabled = diceVisualMode === 'animated';
  const animated = $('diceModeAnimated'), instant = $('diceModeInstant');
  if(!animated || !instant)return;
  animated.checked = enabled; instant.checked = !enabled;
  $('diceModeHelp').textContent = enabled
    ? '🎬 回転→出目表示→コマが1マスずつ移動。途中でスキップできます。'
    : '⚡ 演出を表示せず、出目・ポイント・移動結果を即時反映します。';
}
function renderSelected(){const p=getSelected();const selectedInfo=$('selectedInfo');
const nameInput=$('renamePlayerInput'),renameButton=$('renamePlayerBtn');
if(!p){
  selectedInfo.textContent='参加者がいません';$('rollBtn').disabled=true;$('deletePlayerBtn').disabled=true;
  renameButton.disabled=true;nameInput.disabled=true;nameInput.value='';
  nameInput.dataset.playerId='';nameInput.dataset.playerName='';
  $('viewerDetail').textContent='参加者がいません';return;
}
// 同じ参加者の入力途中にはテキストを初期化せず、参加者選択・名前変更時だけ同期する。
if(nameInput.dataset.playerId!==p.id || nameInput.dataset.playerName!==p.name){
  nameInput.value=p.name;
  nameInput.dataset.playerId=p.id;
  nameInput.dataset.playerName=p.name;
}
nameInput.disabled=!authorized;renameButton.disabled=!authorized;
$('deletePlayerBtn').disabled=!authorized;selectedInfo.innerHTML=`<div class="hero"><b style="color:${p.color}">● ${escapeHtml(p.name)}</b><strong>${p.balance.toLocaleString()} <small>pt</small></strong></div><div class="detailrow"><span>現在位置 ${p.pos} / ${boardCount()}</span><span>累計ギフト ${p.totalGift.toLocaleString()}pt</span></div><div class="detailrow"><span>使用済 ${p.spent.toLocaleString()}pt</span><span>サイコロ ${p.rolls}回</span></div>`;
$('setPosition').value=p.pos;$('setPosition').max=boardCount();$('rollBtn').disabled=p.balance<DICE[selectedDice].cost || p.pos>=boardCount() || !authorized || isRollActive(doc.game.lastRoll);
$('rollBtn').textContent=isRollActive(doc.game.lastRoll)?'🎲 サイコロ演出中…':`🎲 ${DICE[selectedDice].label}サイコロ（${DICE[selectedDice].cost}pt）を使用`;
$('viewerDetail').innerHTML=`<h3 style="color:${p.color}">● ${escapeHtml(p.name)} の詳細</h3><p>現在位置：<b>${p.pos} / ${boardCount()}</b><br>所持ポイント：<b>${p.balance.toLocaleString()}pt</b><br>サイコロ使用回数：<b>${p.rolls}回</b><br>累計ギフト：<b>${p.totalGift.toLocaleString()}pt</b></p><h3>🎲 出目履歴</h3><p>${p.rollHistory.length?p.rollHistory.slice().reverse().map(r=>`${escapeHtml(r.dice)}：${r.face}`).join(' → '):'まだサイコロを振っていません'}</p><h3>📍 止まったマスの履歴</h3><p>${p.path.join(' → ')}</p><h3>👣 実際に通過したマス</h3><p>${(p.visited||p.path).join(' → ')}</p>`;
}
function renderUI(){renderPlayers();renderSelected();renderDiceVisualMode();const g=doc.game;$('playerCount').textContent=g.players.length;$('statPlayers').textContent=g.players.length;$('statRolls').textContent=g.turn;$('statLastRoll').textContent=g.lastRoll?`🎲 ${g.lastRoll.face}`:'–';$('statLastWho').textContent=g.lastRoll?g.lastRoll.name:'NO RECENT ROLLS';$('turnDisplay').textContent=`TURN ${g.turn}`;$('goalLabel').textContent=`🏁 START → GOAL ${boardCount()}`;$('undoBtn').disabled=!doc.past?.length||!authorized;$('redoBtn').disabled=!doc.future?.length||!authorized;
if(inspectedTile!=null){if(inspectedTile>boardCount()){$('tileInspection').hidden=true;inspectedTile=null}else showTileInspection(inspectedTile);}$('eventList').innerHTML=g.events.length?g.events.map(e=>`<div class="event"><span>${escapeHtml(e.text)}</span><span class="eventtime">${escapeHtml(e.time)}</span></div>`).join(''):'<p>まだイベントはありません</p>';
}
function drawRoundRect(x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.stroke()}}
const WIDTH=1200,HEIGHT=670;
function boardMetrics(){const count=boardCount();const cols=Math.min(12,count);const rows=Math.ceil(count/cols);const stepX=cols>1?Math.min(88,960/(cols-1)):0;const stepY=rows>1?Math.min(95,416/(rows-1)):0;const tileW=Math.min(72,stepX?stepX*.83:72);const tileH=Math.min(68,stepY?stepY*.73:68);return {count,cols,rows,stepX,stepY,tileW,tileH};}
function positionXY(pos){const m=boardMetrics(),n=Math.max(1,Math.min(m.count,Math.round(pos)))-1,row=Math.floor(n/m.cols),col=n%m.cols;const dx=row%2===0?col:m.cols-1-col;return {x:600+(dx-(m.cols-1)/2)*m.stepX,y:335+(row-(m.rows-1)/2)*m.stepY};}
function interpolateMarker(player,time){const a=anims[player.id];if(!a)return positionXY(player.pos);const t=(time-a.start)/a.duration;if(t>=1){delete anims[player.id];return positionXY(player.pos);}const segment=Math.abs(a.to-a.from),progress=Math.max(0,Math.min(segment,segment*t)),step=Math.floor(progress),fraction=progress-step;const sign=Math.sign(a.to-a.from),before=positionXY(a.from+step*sign),after=positionXY(a.from+Math.min(step+1,segment)*sign);const blend=fraction*fraction*(3-2*fraction);return {x:before.x+(after.x-before.x)*blend,y:before.y+(after.y-before.y)*blend};}
function animatedRollMarker(player,nowMs){
  const roll=doc.game.lastRoll;
  if(!isRollActive(roll) || player.id!==roll.playerId)return null;
  const t=Math.max(0,nowMs-roll.at),travelStart=ROLL_SPIN_MS+ROLL_REVEAL_MS;
  const units=rollSteps(roll);
  if(t<travelStart)return positionXY(roll.from);
  if(units===0)return positionXY(roll.to);
  const progress=Math.min(units,Math.max(0,(t-travelStart)/ROLL_STEP_MS));
  const whole=Math.floor(progress),fraction=progress-whole;
  const a=positionXY(roll.from+whole),b=positionXY(Math.min(roll.to,roll.from+whole+1));
  // コマをマスごとに着地させるため、各区間の前後をゆっくり動かす。
  const k=fraction*fraction*(3-2*fraction);
  return {x:a.x+(b.x-a.x)*k,y:a.y+(b.y-a.y)*k};
}
function faceDisplay(roll,t){
  if(t>=ROLL_SPIN_MS)return Number(roll.face);
  const valid=DICE[roll.diceType]?.faces || [1,2,3,4,5,6];
  const tick=Math.floor(t/(t>1250?150:t>700?110:75));
  const seed=String(roll.id).split('').reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);
  return valid[((Math.imul((tick+1)^seed,2654435761)>>>16)>>>0)%valid.length];
}
function paintDie(x,y,face,size,kind,angle=0){
  const colors={normal:['#f9fbff','#263447'],slow:['#afffe1','#14573e'],fast:['#ff9d90','#812d2e'],select:['#ffe19b','#735014']};
  const [base,ink]=colors[kind]||colors.normal;
  ctx.save();ctx.translate(x,y);ctx.rotate(angle);
  ctx.shadowColor='#010b18b0';ctx.shadowBlur=24;ctx.shadowOffsetY=13;
  drawRoundRect(-size/2,-size/2,size,size,size*.18,base,'#ffffffaa');
  ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
  const spots={1:[[0,0]],2:[[-1,-1],[1,1]],3:[[-1,-1],[0,0],[1,1]],4:[[-1,-1],[1,-1],[-1,1],[1,1]],5:[[-1,-1],[1,-1],[0,0],[-1,1],[1,1]],6:[[-1,-1],[1,-1],[-1,0],[1,0],[-1,1],[1,1]]};
  ctx.fillStyle=ink;
  for(const [sx,sy] of spots[face]||spots[1]){ctx.beginPath();ctx.arc(sx*size*.28,sy*size*.28,size*.070,0,Math.PI*2);ctx.fill();}
  ctx.restore();
}
function drawDiceSequence(nowMs){
  const roll=doc.game.lastRoll;
  if(!isRollActive(roll))return;
  const t=Math.max(0,nowMs-roll.at),spinning=t<ROLL_SPIN_MS,moving=t>=ROLL_SPIN_MS+ROLL_REVEAL_MS;
  const movingDone=t>=ROLL_SPIN_MS+ROLL_REVEAL_MS+rollSteps(roll)*ROLL_STEP_MS;
  const label=`${roll.name||'プレイヤー'} / ${roll.dice||'サイコロ'}`;
  ctx.save();
  if(!moving){
    ctx.fillStyle='#07111dd5';ctx.fillRect(0,0,WIDTH,HEIGHT);
    ctx.fillStyle='#172840';drawRoundRect(353,96,494,474,28,'#172840','#4c6f88');
    ctx.textAlign='center';ctx.fillStyle='#93e9dc';ctx.font='bold 23px system-ui';ctx.fillText('🎲 DICE ROLL',600,151);
    ctx.fillStyle='#e3f3ff';ctx.font='bold 24px system-ui';ctx.fillText(label.slice(0,30),600,196);
    const angle=spinning?Math.sin(t*.025)*.34+Math.sin(t*.043)*.18:0;
    const pulse=spinning?1+Math.sin(t*.018)*.06:1;
    paintDie(600+Math.sin(t*.014)*(spinning?34:0),342,faceDisplay(roll,t),166*pulse,roll.diceType,angle);
    ctx.font='bold 30px system-ui';ctx.fillStyle=spinning?'#c8d9ef':'#ffdf8f';
    ctx.fillText(spinning?'回転中…':`出目は ${roll.face}！`,600,495);
    ctx.textAlign='left';
  } else {
    ctx.fillStyle='#0d1b2de8';drawRoundRect(355,70,490,92,20,'#0d1b2de8','#69cdbc');
    ctx.textAlign='center';ctx.fillStyle='#a5efe3';ctx.font='bold 22px system-ui';ctx.fillText(`${roll.name}  🎲 ${roll.face} マス`,600,110);
    ctx.fillStyle='#e0f4ff';ctx.font='bold 17px system-ui';ctx.fillText(movingDone?`到着！ ${roll.to} マス`:'コマが移動中…',600,143);
    ctx.textAlign='left';
  }
  ctx.restore();
}
let rollUiShown=false;
function syncRollControls(){
  const show=isRollActive(doc.game.lastRoll);
  if(show===rollUiShown)return;
  rollUiShown=show;
  $('skipRollBtn').hidden=!show || role!=='admin';
  renderSelected();
}
function drawBoard(time){ctx.clearRect(0,0,WIDTH,HEIGHT);
const grad=ctx.createLinearGradient(0,0,WIDTH,HEIGHT);grad.addColorStop(0,'#122b43');grad.addColorStop(1,'#0c1a2b');ctx.fillStyle=grad;ctx.fillRect(0,0,WIDTH,HEIGHT);
ctx.fillStyle='#8ddbd7';ctx.font='800 15px system-ui';ctx.fillText('SUGOROKU BOARD   /   LIVE SESSION',68,55);
ctx.textAlign='right';ctx.fillStyle='#90a7c0';ctx.font='14px system-ui';ctx.fillText(`${doc.game.players.length} PLAYERS     •     TURN ${doc.game.turn}`,1120,55);ctx.textAlign='left';
const m=boardMetrics();ctx.strokeStyle='#486b79';ctx.lineWidth=Math.max(3,Math.min(6,m.tileH/10));ctx.lineCap='round';ctx.beginPath();for(let i=1;i<=m.count;i++){const {x,y}=positionXY(i);if(i===1)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke();
for(let i=1;i<=m.count;i++){
const {x,y}=positionXY(i),tile=tileInfo(i),goal=i===m.count,start=i===1,kind=tile.kind;
const bg=goal?'#26634f':start?'#2d527c':TILE_KIND_COLORS[kind];
drawRoundRect(x-m.tileW/2,y-m.tileH/2,m.tileW,m.tileH,Math.min(13,m.tileH/5),bg,'#58708b');
ctx.textAlign='center';ctx.fillStyle=goal?'#b6ffdc':kind==='normal'?'#c8daeb':'#f8dfb1';
ctx.font=`700 ${Math.max(12,Math.min(21,m.tileH*.33))}px system-ui`;
ctx.fillText(String(i),x,y+(tile.title||kind!=='normal'?0:5));
let label=tile.title||(goal?'GOAL':start?'START':({event:'★ EVENT',bonus:'✦ BONUS',warning:'! 注意'}[kind]||''));
if(label && m.tileH>25){ctx.font=`${Math.max(8,Math.min(12,m.tileH*.19))}px system-ui`;const cap=m.tileW>56?8:5;const shortLabel=label.length>cap?label.slice(0,cap-1)+'…':label;ctx.fillText(shortLabel,x,y+m.tileH*.32)}ctx.textAlign='left';}
const overlays=new Map();for(const p of doc.game.players){const pos=animatedRollMarker(p,Date.now())||interpolateMarker(p,time),key=`${Math.round(pos.x/75)}-${Math.round(pos.y/55)}`;let arr=overlays.get(key)||[];arr.push({player:p,xy:pos});overlays.set(key,arr)}
for(const arr of overlays.values())arr.forEach(({player:p,xy},i)=>{const col=i%3,row=Math.floor(i/3),cx=xy.x-18+col*18,cy=xy.y-18-row*18;ctx.beginPath();ctx.arc(cx,cy,10,0,Math.PI*2);ctx.fillStyle=p.color;ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#f1f7ff';ctx.stroke();ctx.fillStyle='#102030';ctx.font='bold 11px system-ui';ctx.textAlign='center';ctx.fillText(p.name.slice(0,1),cx,cy+4);ctx.textAlign='left'});
ctx.fillStyle='#95a8bf';ctx.font='13px system-ui';ctx.fillText('📍 マスをタップすると内容を確認できます',69,628);
const last=doc.game.lastRoll;if(last){ctx.textAlign='right';ctx.fillStyle='#a5f0d7';ctx.font='bold 15px system-ui';ctx.fillText(`🎲 ${last.name}：${last.face} マス`,1120,628);ctx.textAlign='left'}
drawDiceSequence(Date.now());
syncRollControls();
requestAnimationFrame(drawBoard);
}
function showTileInspection(n){inspectedTile=n;const t=tileInfo(n);$('tileInspection').hidden=false;$('tileInspectionTitle').textContent=`${n}マス：${t.title||TILE_KIND_LABELS[t.kind]}`;$('tileInspectionDescription').textContent=t.description||'このマスに説明は登録されていません。';}
function openTileFromCanvas(ev){const r=canvas.getBoundingClientRect(),x=(ev.clientX-r.left)*(WIDTH/r.width),y=(ev.clientY-r.top)*(HEIGHT/r.height),m=boardMetrics();let best=null,distance=Infinity;for(let i=1;i<=m.count;i++){const pos=positionXY(i),dx=Math.abs(x-pos.x),dy=Math.abs(y-pos.y),d=dx*dx+dy*dy;if(dx<=Math.max(m.tileW/2,12)+6&&dy<=Math.max(m.tileH/2,12)+6&&d<distance){best=i;distance=d;}}if(best!=null)showTileInspection(best);}
function resetOvershootPlayers(g,newCount){for(const p of g.players){if(p.pos>newCount){p.pos=newCount;p.path=(p.path||[]).filter(n=>n<=newCount);if(p.path.at(-1)!==newCount)p.path.push(newCount);p.visited=(p.visited||[]).filter(n=>n<=newCount);if(!p.visited.includes(newCount))p.visited.push(newCount);}}}
function renderBoardEditorTiles(){const root=$('boardCellList');if(!boardDraft)return;root.innerHTML='';const frag=document.createDocumentFragment();for(let n=1;n<=boardDraft.count;n++){const tile=boardDraft.cells[String(n)]||{kind:'normal',title:'',description:''},btn=document.createElement('button');btn.type='button';btn.className=`boardCellButton ${tile.kind||'normal'}${n===editingTile?' active':''}`;btn.innerHTML=`<b>${n}</b><small>${escapeHtml(tile.title||TILE_KIND_LABELS[tile.kind]||'通常')}</small>`;btn.onclick=()=>{editingTile=n;renderBoardEditorTiles();renderBoardEditorForm()};frag.appendChild(btn);}root.appendChild(frag)}
function renderBoardEditorForm(){if(!boardDraft)return;const t=boardDraft.cells[String(editingTile)]||{kind:'normal',title:'',description:''};$('editingTileHeading').textContent=`${editingTile} マス目を編集`;$('tileKindInput').value=t.kind||'normal';$('tileTitleInput').value=t.title||'';$('tileDescInput').value=t.description||'';$('boardEditorSummary').textContent=`${boardDraft.count}マス / ${boardDirty?'未保存の変更あり':'編集後に保存してください'}`;}
function saveTileFields(){if(!boardDraft)return;const n=editingTile,k=$('tileKindInput').value,title=$('tileTitleInput').value.slice(0,18),description=$('tileDescInput').value.slice(0,300);if(k==='normal'&&!title&&!description)delete boardDraft.cells[String(n)];else boardDraft.cells[String(n)]={kind:k,title,description};boardDirty=true;$('tileDraftStatus').textContent='未保存';$('boardEditorSummary').textContent=`${boardDraft.count}マス / 未保存の変更あり`;renderBoardEditorTiles();}
function openBoardEditor(){if(!canOperate())return;boardDraft=clone(validBoard(doc.game));boardDirty=false;editingTile=1;$('boardCountInput').value=boardDraft.count;$('boardEditorOverlay').hidden=false;renderBoardEditorTiles();renderBoardEditorForm();}
function closeBoardEditor(){if(boardDirty&&!confirm('保存していない盤面の変更を破棄しますか？'))return;$('boardEditorOverlay').hidden=true;boardDraft=null;boardDirty=false;}
function updateBoardCount(){if(!boardDraft)return;const n=Number($('boardCountInput').value);if(!Number.isSafeInteger(n)||n<1||n>120){notice('マス数は1〜120の整数で指定してください');return;}boardDraft.count=n;boardDraft.cells=Object.fromEntries(Object.entries(boardDraft.cells).filter(([key])=>Number(key)<=n));editingTile=Math.min(n,editingTile);boardDirty=true;renderBoardEditorTiles();renderBoardEditorForm();notice(`仮のマス数を ${n} に変更しました。保存すると盤面へ反映されます。`);}
async function saveBoardEditor(){if(!boardDraft)return;const requested=Number($('boardCountInput').value);if(!Number.isSafeInteger(requested)||requested<1||requested>120){notice('マス数は1〜120の整数で指定してください');return;}if(requested!==boardDraft.count){boardDraft.count=requested;boardDraft.cells=Object.fromEntries(Object.entries(boardDraft.cells).filter(([key])=>Number(key)<=requested));}const nextBoard=clone(boardDraft),oldCount=boardCount();if(nextBoard.count<oldCount&&doc.game.players.some(p=>p.pos>nextBoard.count)){if(!confirm('現在位置が新しいゴールを超える参加者がいます。新しいゴール位置へ補正して保存しますか？'))return;}const saved=await commit(g=>{g.board=clone(nextBoard);resetOvershootPlayers(g,nextBoard.count);addEvent(g,`✎ 盤面を編集（${nextBoard.count}マス）`);},`盤面を${nextBoard.count}マスに更新しました`);if(saved){boardDraft=null;boardDirty=false;$('boardEditorOverlay').hidden=true;}}
function adjustZoom(delta){zoom=Math.max(.65,Math.min(2.5,Math.round((zoom+delta)*100)/100));canvas.style.width=`${zoom*100}%`;$('zoomLevel').textContent=Math.round(zoom*100)+'%';}
function setupPip(){const video=$('pipVideo');if(typeof canvas.captureStream!=='function')return;try{video.srcObject=canvas.captureStream(15);video.play().catch(()=>{});}catch(e){console.info('PiP準備:',e)}}
async function openPiP(){const video=$('pipVideo');try{if(!video.srcObject){if(typeof canvas.captureStream!=='function')throw new Error('このブラウザではCanvasの映像化に未対応です');video.srcObject=canvas.captureStream(15);}await video.play();if(document.pictureInPictureElement){await document.exitPictureInPicture();return;}if(typeof video.requestPictureInPicture==='function'){await video.requestPictureInPicture();return;}if(typeof video.webkitSetPresentationMode==='function'&&typeof video.webkitSupportsPresentationMode==='function'&&video.webkitSupportsPresentationMode('picture-in-picture')){video.webkitSetPresentationMode('picture-in-picture');return;}throw new Error('この端末のブラウザはPiPに対応していません');}catch(e){console.warn(e);notice('小窓表示に失敗しました。端末・ブラウザ制限の可能性があります。');}}
function bindEvents(){document.body.classList.toggle('viewer',role==='viewer');$('switchRole').textContent=role==='viewer'?'管理画面へ ↗':'観戦画面へ ↗';$('switchRole').href=role==='viewer'?'?role=admin':'?role=viewer';
$('zoomIn').onclick=()=>adjustZoom(.2);$('zoomOut').onclick=()=>adjustZoom(-.2);$('pipBtn').onclick=openPiP;
for(const radio of document.querySelectorAll('input[name="diceVisualMode"]')){
  radio.addEventListener('change',()=>{
    if(!radio.checked || role!=='admin')return;
    diceVisualMode=radio.value==='instant'?'instant':'animated';
    localStorageSet(DICE_VISUAL_MODE_KEY,diceVisualMode);
    renderDiceVisualMode();
  });
}
$('shareBtn').onclick=async()=>{const u=new URL(location.href);u.searchParams.set('role','viewer');try{await navigator.clipboard.writeText(u.href);notice('観戦画面のURLをコピーしました')}catch{prompt('このURLをコピーしてください',u.href)}};
$('searchPlayer').oninput=renderPlayers;
$('gameCanvas').addEventListener('click',openTileFromCanvas);
$('closeTileInspection').onclick=()=>{$('tileInspection').hidden=true;inspectedTile=null;};
$('openBoardEditor').onclick=openBoardEditor;
$('closeBoardEditor').onclick=closeBoardEditor;
$('cancelBoardEditor').onclick=closeBoardEditor;
$('applyBoardCount').onclick=updateBoardCount;
$('tileKindInput').onchange=saveTileFields;
$('tileTitleInput').oninput=saveTileFields;
$('tileDescInput').oninput=saveTileFields;
$('clearTileButton').onclick=()=>{delete boardDraft.cells[String(editingTile)];boardDirty=true;renderBoardEditorTiles();renderBoardEditorForm();};
$('saveBoardEditor').onclick=saveBoardEditor;
$('boardEditorOverlay').addEventListener('click',e=>{if(e.target===$('boardEditorOverlay'))closeBoardEditor();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('boardEditorOverlay').hidden)closeBoardEditor();});
$('addPlayerForm').onsubmit=async e=>{e.preventDefault();const input=$('newName');const value=input.value;if(!value.trim())return;await addPlayer(value);input.value='';};
$('renamePlayerForm').onsubmit=async e=>{
  e.preventDefault();
  const p=getSelected();
  if(!p || !canOperate())return;
  const targetId=p.id;
  const newName=$('renamePlayerInput').value.trim();
  if(!newName || newName.length>20){notice('プレイヤー名は1〜20文字で入力してください');return;}
  if(newName===p.name){notice('現在と同じ名前です');return;}
  // 入力が古い状態（他の端末から既に変更された等）なら名前変更せずに再確認。
  if($('renamePlayerInput').dataset.playerId!==targetId || $('renamePlayerInput').dataset.playerName!==p.name){
    notice('選択中の参加者の情報が変わりました。名前を確認して再度変更してください');
    $('renamePlayerInput').dataset.playerId='';renderSelected();return;
  }
  if(doc.game.players.some(other=>other.id!==targetId && other.name===newName)){
    notice('同じ名前の参加者がいます。別の名前を指定してください');return;
  }
  const oldName=p.name;
  const saved=await commit(g=>{
    const target=g.players.find(player=>player.id===targetId);
    if(!target || target.name!==oldName || g.players.some(other=>other.id!==targetId && other.name===newName))return false;
    target.name=newName;
    // 最新の結果表示でも新しいプレイヤー名を表示（過去の操作ログは記録時の名前を保存）。
    if(g.lastRoll?.playerId===targetId)g.lastRoll.name=newName;
    addEvent(g,`✏️ ${oldName} の名前を ${newName} に変更`);
  },`プレイヤー名を「${newName}」に変更しました`);
  if(saved){$('renamePlayerInput').dataset.playerId='';renderSelected();}
};
$('addPointForm').onsubmit=async e=>{e.preventDefault();const p=getSelected();if(!p)return;const n=Number($('pointAmount').value);if(!Number.isSafeInteger(n)||n<=0||n>1000000){notice('1～1,000,000の整数を入力してください');return;}await commit(g=>{const target=g.players.find(p=>p.id===selectedId);if(!target)return false;target.balance+=n;target.totalGift+=n;addEvent(g,`💎 ${target.name} に ${n.toLocaleString()}pt 追加`);},`${p.name} に ${n}pt 追加しました`);};
for(const button of document.querySelectorAll('[data-dice]'))button.onclick=()=>{selectedDice=button.dataset.dice;document.querySelectorAll('[data-dice]').forEach(el=>el.classList.toggle('active',el===button));$('selectRollRow').hidden=selectedDice!=='select';renderSelected()};
$('rollBtn').onclick=async()=>{
  const p=getSelected(), diceType=selectedDice,dice=DICE[diceType],visualMode=diceVisualMode;
  if(!p || !canOperate())return;
  if(isRollActive(doc.game.lastRoll)){notice('前のサイコロ演出が終わるまでお待ちください');return;}
  const playerId=p.id,face=diceType==='select'?Number($('selectedFace').value):dice.faces[Math.floor(Math.random()*dice.faces.length)];
  const rollId=makeRollId();
  $('rollBtn').disabled=true;
  const ok=await commit(g=>{
    const target=g.players.find(player=>player.id===playerId);
    // 同時に複数のマスターが操作しても、ひとつのサイコロ演出中は次のサイコロを認めない。
    if(isRollActive(g.lastRoll)||!target||target.balance<dice.cost||target.pos>=boardCount(g))return false;
    target.balance-=dice.cost;target.spent+=dice.cost;target.rolls++;
    const from=target.pos;target.pos=Math.min(boardCount(g),target.pos+face);
    target.path.push(target.pos);target.visited=target.visited||[from];
    for(let m=from+1;m<=target.pos;m++)target.visited.push(m);
    target.rollHistory.push({dice:dice.label,face,from,to:target.pos});
    g.turn++;
    g.lastRoll={id:rollId,at:Date.now(),playerId,name:target.name,from,to:target.pos,face,dice:dice.label,diceType,cost:dice.cost,skipped:visualMode==='instant'};
    addEvent(g,`🎲 ${target.name} が${dice.label}サイコロで ${face}（${from}→${target.pos}） / −${dice.cost}pt`);
  },`${p.name}：🎲 ${face} が出ました（${visualMode==='instant'?'演出なし':'演出あり'}）`);
  if(!ok)renderSelected();
};
$('skipRollBtn').onclick=async()=>{
  if(!canOperate())return;
  const id=doc.game.lastRoll?.id;
  if(!id || !isRollActive(doc.game.lastRoll))return;
  const change=raw=>{const next=clone(safeDocument(raw));if(next.game.lastRoll?.id!==id)return;next.game.lastRoll.skipped=true;return next;};
  try{
    if(CLOUD){const res=await stateRef.transaction(change,undefined,false);if(!res.committed)notice('スキップできませんでした');}
    else{const next=change(doc);if(next)localWrite(next);}
    notice('サイコロ演出をスキップしました');
  }catch(e){console.error(e);notice('演出スキップに失敗しました');}
};
$('undoBtn').onclick=()=>historyChange('undo');$('redoBtn').onclick=()=>historyChange('redo');
$('fixPosition').onclick=async()=>{const p=getSelected(),val=Number($('setPosition').value);if(!p||!Number.isInteger(val)||val<1||val>boardCount()){notice(`位置は1～${boardCount()}で指定してください`);return;}await commit(g=>{const target=g.players.find(t=>t.id===selectedId);if(!target)return false;const old=target.pos;target.pos=val;target.path.push(val);addEvent(g,`🛠 ${target.name} の位置を修正 ${old}→${val}`)},`${p.name} の位置を修正しました`)};
$('deletePlayerBtn').onclick=async()=>{
  const p=getSelected();
  if(!p||!canOperate())return;
  const targetId=p.id, targetName=p.name;
  if(!confirm(`「${targetName}」を参加者一覧から削除しますか？\n\n所持ポイント、コマ、個別のサイコロ・通過履歴も削除されます。\n誤って削除した場合は、直後に「巻き戻す」で復元できます。`))return;
  const success=await commit(g=>{
    const index=g.players.findIndex(player=>player.id===targetId);
    if(index===-1)return false;
    g.players.splice(index,1);
    addEvent(g,`🗑 ${targetName} を参加者一覧から削除`);
  },`${targetName} を削除しました`);
  if(success){selectedId=doc.game.players[0]?.id||null;renderUI();}
};
$('resetBtn').onclick=async()=>{if(!confirm('テストデータを初期化しますか？ 操作履歴も消去されます。'))return;if(!canOperate())return;const initial=makeDoc();try{if(CLOUD)await stateRef.set(initial);else localWrite(initial);selectedId='p1';renderUI();notice('テストデータを初期化しました')}catch(e){notice('初期化できませんでした：'+e.message)}};
$('requestForm').onsubmit=async e=>{e.preventDefault();const name=$('requestName').value.trim().slice(0,20);if(!name)return;try{if(CLOUD){if(!firebaseUser)throw new Error('認証がまだ完了していません');await cloudDB.ref(`rooms/${ROOM}/requests/${firebaseUser.uid}`).set({name,time:Date.now()});}else{pendingRequests[localViewerId]={name,time:Date.now()};localStorageSet(REQUEST_KEY,JSON.stringify(pendingRequests));channel?.postMessage({type:'join-request',uid:localViewerId,name,time:Date.now()});renderRequests();}$('requestStatus').textContent='申請しました。管理者の承認をお待ちください。';notice('参加申請を送りました')}catch(err){notice('申請に失敗しました：'+err.message)}};
$('authForm').onsubmit=async e=>{e.preventDefault();$('authError').textContent='';try{await cloudAuth.signInWithEmailAndPassword($('authEmail').value,$('authPassword').value)}catch(err){$('authError').textContent='ログインできませんでした。メールとパスワードを確認してください。'}};
$('addMasterBtn').onclick=async()=>{
 if(!ownerLoggedIn || !cloudDB || !firebaseUser) return;
 const uid=$('masterUid').value.trim();
 if(!/^[a-zA-Z0-9_-]{6,128}$/.test(uid)){notice('Firebase Authenticationの有効なUIDを入力してください');return;}
 if(uid===window.SUGOROKU_OWNER_UID){notice('オーナーは追加登録不要です');return;}
 try{await cloudDB.ref(`rooms/${ROOM}/masters/${uid}`).set(true);$('masterUid').value='';notice('マスター権限を付与しました');}catch(e){notice('権限の付与に失敗しました：'+e.message);}
};
}
function renderRequests(){if(role!=='admin')return;const entries=Object.entries(pendingRequests||{});$('joinRequests').hidden=entries.length===0;if(!entries.length)return;$('joinRequests').innerHTML='<strong>🙋 参加申請</strong>'+entries.map(([uid,r])=>`<div class="request"><span>${escapeHtml(r.name)}</span><button type="button" data-request="${escapeHtml(uid)}">承認</button></div>`).join('');for(const btn of $('joinRequests').querySelectorAll('[data-request]'))btn.onclick=async()=>{const uid=btn.dataset.request,name=pendingRequests[uid]?.name;if(!name)return;await addPlayer(name,uid);if(CLOUD){await cloudDB.ref(`rooms/${ROOM}/requests/${uid}`).remove().catch(console.error)}else{delete pendingRequests[uid];localStorageSet(REQUEST_KEY,JSON.stringify(pendingRequests));channel?.postMessage({type:'request-updated',pendingRequests})}renderRequests()};}
function setupLocal(){const fromStorage=localStorageGet(LOCAL_KEY);if(fromStorage){try{doc=safeDocument(JSON.parse(fromStorage))}catch{doc=makeDoc()}}localStorageSet(LOCAL_KEY,JSON.stringify(doc));try{pendingRequests=JSON.parse(localStorageGet(REQUEST_KEY)||'{}')}catch{pendingRequests={}}
if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('stream-sugoroku-local-v2');channel.onmessage=e=>{const msg=e.data;if(msg?.type==='state')useDoc(msg.doc);if(msg?.type==='join-request'&&role==='admin'){pendingRequests[msg.uid]={name:msg.name,time:msg.time};localStorageSet(REQUEST_KEY,JSON.stringify(pendingRequests));renderRequests()}if(msg?.type==='request-updated'){pendingRequests=msg.pendingRequests||{};renderRequests()}}}
window.addEventListener('storage',e=>{if(e.key===LOCAL_KEY&&e.newValue){try{useDoc(JSON.parse(e.newValue))}catch{}}if(e.key===REQUEST_KEY){try{pendingRequests=JSON.parse(e.newValue||'{}');renderRequests()}catch{}}});$('connection').innerHTML='<span class="statusdot"></span> ローカル・タブ間同期';$('modeHint').textContent='同一ブラウザ／同じサイト内のみ同期。別端末への同期にはFirebase設定が必要';renderUI();renderRequests();}
function appendScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error(src+' の読み込みに失敗'));document.head.appendChild(s)})}
async function setupCloud(){authorized=false;$('connection').textContent='☁ 接続中…';$('modeHint').textContent='Firebase同期モード';const v='11.10.0';try{await appendScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);await appendScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);await appendScript(`https://www.gstatic.com/firebasejs/${v}/firebase-database-compat.js`);firebase.initializeApp(window.SUGOROKU_FIREBASE_CONFIG);cloudAuth=firebase.auth();cloudDB=firebase.database();stateRef=cloudDB.ref(`rooms/${ROOM}/state`);
stateRef.on('value',s=>{const raw=s.val();if(raw)useDoc(raw);else if(authorized)stateRef.transaction(data=>data||makeDoc(),undefined,false).catch(console.error);$('connection').innerHTML='<span class="statusdot"></span> Firebase リアルタイム同期'},error=>{console.error(error);notice('DBを読み取れません。Firebaseのルールを確認してください。')});
cloudAuth.onAuthStateChanged(async user => {
  firebaseUser = user;
  ownerLoggedIn = role === 'admin' && !!user && user.uid === window.SUGOROKU_OWNER_UID;
  let grantedMaster = false;
  if(role === 'admin' && user && !ownerLoggedIn){
    try{
      const membership = await cloudDB.ref(`rooms/${ROOM}/masters/${user.uid}`).once('value');
      grantedMaster = membership.val() === true;
    }catch(e){console.warn('マスター権限の照会に失敗', e);}
  }
  authorized = role === 'admin' && !!user && (ownerLoggedIn || grantedMaster);
  if(role === 'admin') {
    $('authModal').hidden = authorized;
    $('ownerTools').hidden = !ownerLoggedIn;
    const err = $('authError');
    if(user && !authorized) err.textContent = 'このアカウントには管理権限がありません。オーナーへUIDの登録を依頼してください。';
    if(authorized) {
      $('connection').innerHTML = '<span class="statusdot"></span> マスターログイン済み';
      if(!cloudRequestsRef){
        cloudRequestsRef = cloudDB.ref(`rooms/${ROOM}/requests`);
        cloudRequestsRef.on('value', snap => { pendingRequests=snap.val()||{};renderRequests(); });
      }
      const ss = await stateRef.once('value');
      if(!ss.exists()) await stateRef.transaction(data => data || makeDoc(), undefined, false);
    } else {
      if(cloudRequestsRef){ cloudRequestsRef.off();cloudRequestsRef=null; }
      pendingRequests={};renderRequests();
    }
    if(masterListRef){masterListRef.off();masterListRef=null;}
    if(ownerLoggedIn) {
      masterListRef = cloudDB.ref(`rooms/${ROOM}/masters`);
      masterListRef.on('value', snap => {
        const ids=Object.keys(snap.val()||{});
        $('masterList').innerHTML=ids.length?'':'<small>追加したマスターはいません</small>';
        for(const uid of ids){
          const row=document.createElement('div');row.className='event';
          const text=document.createElement('span');text.textContent=uid;
          text.style.overflowWrap='anywhere';
          const btn=document.createElement('button');btn.type='button';btn.textContent='解除';btn.className='ghost';
          btn.onclick=async()=>{if(!confirm('このマスターの権限を解除しますか？'))return;try{await cloudDB.ref(`rooms/${ROOM}/masters/${uid}`).remove();notice('権限を解除しました')}catch(e){notice('権限の解除に失敗しました')}};
          row.append(text,btn);$('masterList').appendChild(row);
        }
      }, err=>notice('マスター一覧の取得に失敗しました：'+err.message));
    }
    renderUI();
  } else if(!user) {
    try{ await cloudAuth.signInAnonymously(); }
    catch(e){ notice('匿名認証ができません。FirebaseのAuthentication設定を確認してください。'); }
  } else {
    cloudDB.ref(`rooms/${ROOM}/requests/${user.uid}`).on('value', snap => {
      if(snap.exists()) $('requestStatus').textContent='申請中（管理者の承認待ち）';
      else if(doc.game.players.some(p=>p.id===user.uid)) $('requestStatus').textContent='参加承認済みです';
    });
  }
});
}catch(err){console.error(err);$('connection').textContent='⚠ 接続失敗';$('modeHint').textContent='Firebaseの設定を見直してください';notice('Firebase接続に失敗しました：'+err.message);if(role==='admin'){$('authModal').hidden=false;$('authError').textContent='Firebaseに接続できませんでした。設定をご確認ください。'}}}
function start(){bindEvents();if(role==='viewer'){$('adminTools').hidden=true;$('viewerTools').hidden=false;}renderUI();setupPip();requestAnimationFrame(drawBoard);if(CLOUD)setupCloud();else setupLocal();}
start();
