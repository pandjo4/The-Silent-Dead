
const $ = id => document.getElementById(id);
let socket=null, state=null, selectedEvidence=null, selectedTarget=null, selectedSuspect=null, rounds=4, soundOn=false, audioCtx=null;
const screens=["homeScreen","lobbyScreen","gameScreen","endScreen"];
function showScreen(id){screens.forEach(x=>$(x).classList.toggle("hidden",x!==id));}
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.remove("hidden");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.add("hidden"),2800);}
function connect(){if(socket){if(!socket.connected)socket.connect();return;}socket=io({transports:["websocket","polling"], reconnection:true, reconnectionAttempts:Infinity});socket.on("connect",()=>{$("connection").classList.add("online");$("connection").innerHTML="<i></i> CONNECTED";});socket.on("disconnect",()=>{$("connection").classList.remove("online");$("connection").innerHTML="<i></i> RECONNECTING";});socket.on("game:error",x=>toast(x.message));socket.on("game:state",s=>{
  if(state && s.round!==state.round) { selectedEvidence=null; selectedTarget=null; selectedSuspect=null; }
  state=s; render();
});socket.on("room:removed",()=>{localStorage.removeItem("silentDeadSession");state=null;showScreen("homeScreen");toast("You have been removed from the room.");});}
function waitForConnection(){if(socket?.connected)return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error("Could not connect to the game server. Please try again."));},12000);const ok=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(new Error("The game server could not be reached."));};function cleanup(){clearTimeout(timer);socket.off("connect",ok);socket.off("connect_error",fail);}socket.once("connect",ok);socket.once("connect_error",fail);});}
function saveSession(x){localStorage.setItem("silentDeadSession",JSON.stringify({code:x.code,playerId:x.playerId,token:x.token}));}
function emit(event,payload={}){return new Promise(resolve=>socket.emit(event,payload,res=>{if(!res?.ok)toast(res?.message||"Something went wrong.");resolve(res||{ok:false});}));}
async function createRoom(){try{connect();await waitForConnection();const res=await emit("room:create",{name:$("playerName").value,rounds,shuffleLimit:Number($("shuffleLimit").value)});if(res.ok){saveSession(res);state=res.state;showScreen("lobbyScreen");render();}}catch(e){toast(e.message);}}
async function joinRoom(){try{connect();await waitForConnection();const res=await emit("room:join",{name:$("playerName").value,code:$("roomCode").value});if(res.ok){saveSession(res);state=res.state;showScreen("lobbyScreen");render();}}catch(e){toast(e.message);}}
function reconnect(){const raw=localStorage.getItem("silentDeadSession");if(!raw)return;try{const x=JSON.parse(raw);connect();socket.on("connect",async()=>{const res=await emit("room:reconnect",x);if(res.ok){state=res.state;render();}else{localStorage.removeItem("silentDeadSession");}});}catch(e){localStorage.removeItem("silentDeadSession");}}
function isAdmin(){return state?.you?.isAdmin}
function render(){if(!state)return;if(state.phase==="lobby"){showScreen("lobbyScreen");renderLobby();return;}if(state.phase==="finished"){showScreen("endScreen");renderEnd();return;}showScreen("gameScreen");renderGame();}
function renderLobby(){ $("lobbyCode").textContent=state.code;$("playerCount").textContent=`${state.players.length} / 6`;
 $("playerList").innerHTML=state.players.map((p,i)=>`<div class="player-row"><div class="player-avatar" style="color:${p.color}">${esc(p.name.slice(0,1).toUpperCase())}</div><div class="player-name">${esc(p.name)}</div><span class="player-meta">${p.id===state.adminId?"HOST": "GUEST"}</span><span class="online-state">${p.connected?"● ONLINE":"○ AWAY"}</span>${isAdmin()&&p.id!==state.adminId?`<button class="text-btn" data-kick="${p.id}">REMOVE</button>`:""}</div>`).join("");
 $("playerList").querySelectorAll("[data-kick]").forEach(b=>b.onclick=()=>emit("room:kick",{playerId:b.dataset.kick}));
 $("ghostSelect").innerHTML=`<option value="">Choose the Ghost…</option>`+state.players.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
 $("ghostSelect").value=state.ghostId||"";
 $("shuffleLimit").value=String(state.settings.shuffleLimit ?? 3);$("shuffleLimit").disabled=!isAdmin();
 $("ghostSelect").disabled=!isAdmin();$("roundOptions").querySelectorAll("button").forEach(b=>{b.classList.toggle("selected",Number(b.dataset.round)===state.settings.rounds);b.disabled=!isAdmin();});
 $("startGame").disabled=!isAdmin()||state.players.length<2;$("closeRoom").classList.toggle("hidden",!isAdmin());
}
function renderGame(){const me=state.you;const ghost=me.role==="ghost";$("roundLabel").textContent=`${state.round} / ${state.maxRounds}`;$("pauseBanner").classList.toggle("hidden",!state.paused);$("pauseText").textContent=state.pauseReason||"Waiting for reconnection…";
 $("phaseEyebrow").textContent=state.phase==="distribute"?"THE GHOST LEAVES SIGNS":state.phase==="select"?"THE DETECTIVES MUST CHOOSE":"THE TRUTH EMERGES";
 $("phaseTitle").textContent=state.phase==="distribute"?"The evidence":state.phase==="select"?"Choose a face": "The reveal";
 $("suspectBoard").innerHTML=state.board.map(s=>{const pawns=state.pawns.filter(p=>p.position===s.position&&!p.solved);const mine=selectedSuspect===s.position;return `<button class="suspect-card ${mine?"selected":""} ${s.eliminated?"eliminated":""}" data-pos="${s.position}" ${(!ghost&&state.phase==="select"&&!s.eliminated&&!me.solved&&!state.paused&&!state.pawns.find(p=>p.playerId===me.id)?.locked)?"":"disabled"}><span class="suspect-number">${String(s.position).padStart(2,"0")}</span><img src="${asset(s.image)}" onerror="this.onerror=null;this.src='assets/evidence/placeholder.svg'"><div class="suspect-name">${esc(s.name)}</div><div class="pawn-stack">${pawns.map(p=>`<i class="pawn-dot" style="background:${p.color}" title="${esc(p.name)}"></i>`).join("")}</div></button>`;}).join("");
 $("suspectBoard").querySelectorAll("[data-pos]").forEach(b=>b.onclick=()=>{selectedSuspect=Number(b.dataset.pos);emit("detective:select",{position:selectedSuspect});});
 $("pawnLegend").innerHTML=state.players.filter(p=>p.role==="detective").map(p=>`<span class="legend-item"><i class="legend-dot" style="background:${p.color}"></i>${esc(p.name)}${p.solved?" · SOLVED":""}</span>`).join("");
 $("ghostPanel").classList.toggle("hidden",!ghost);$("detectivePanel").classList.toggle("hidden",ghost||me.solved);$("waitingPanel").classList.toggle("hidden",ghost||!me.solved);
 $("statusList").innerHTML=state.players.filter(p=>p.role==="detective").map(p=>`<div class="status-row"><i class="legend-dot" style="background:${p.color}"></i><span class="status-name">${esc(p.name)}</span><span class="status-badge ${p.solved?"solved":""}">${p.solved?"SOLVED":p.connected?"INVESTIGATING":"DISCONNECTED"}</span></div>`).join("");
 renderReveal();
 if(ghost)renderGhost();else renderDetective();
}
function renderGhost(){const dist=state.distribution;$("handCount").textContent=`${state.hand.length} CARDS`;$("shuffleCount").textContent=`${dist.shuffleRemaining} LEFT`;
 $("ghostHand").innerHTML=state.hand.map(c=>`<button class="evidence-card ${selectedEvidence===c.id?"selected":""}" data-card="${c.id}"><img src="${asset(c.image)}" onerror="this.onerror=null;this.src='assets/evidence/placeholder.svg'"><strong>${esc(c.name)}</strong></button>`).join("");
 $("ghostHand").querySelectorAll("[data-card]").forEach(b=>b.onclick=()=>{selectedEvidence=b.dataset.card;renderGhost();});
 $("targetList").innerHTML=`<div class="target-buttons">${state.players.filter(p=>p.role==="detective"&&!p.solved).map(p=>`<button class="target-btn ${selectedTarget===p.id?"active":""}" data-target="${p.id}" style="border-left:3px solid ${p.color}">${esc(p.name)}</button>`).join("")}</div>`;
 $("targetList").querySelectorAll("[data-target]").forEach(b=>b.onclick=()=>{selectedTarget=b.dataset.target;renderGhost();});
 $("sendEvidence").textContent=selectedEvidence&&selectedTarget?"SEND EVIDENCE TO SELECTED DETECTIVE":"SELECT A CARD AND DETECTIVE";
 $("sendEvidence").disabled=!selectedEvidence||!selectedTarget||state.phase!=="distribute"||state.paused;
 $("sendEvidence").onclick=()=>selectedEvidence&&distribute(selectedEvidence);
 $("ghostHand").querySelectorAll(".evidence-card").forEach(b=>b.ondblclick=()=>distribute(b.dataset.card));
 $("shuffleBtn").disabled=dist.shuffleRemaining<=0||state.phase!=="distribute"||state.paused;
 $("finishDistribution").disabled=state.phase!=="distribute"||state.paused||dist.counts[dist.phase]<1;
 $("distributionHint").textContent=`Phase ${dist.phase} of 2 · ${dist.counts[dist.phase]} card(s) distributed. Select a card and a detective, then press Send Evidence.`;
 $("finishDistribution").textContent=dist.phase===1?"FINISH FIRST PHASE  ↗":"FINISH DISTRIBUTION  ↗";
 const ass=state.secretAssignments||[];$("secretAssignments").innerHTML=ass.map(a=>`<div class="secret-row"><span style="color:${a.color}">${esc(a.name)}</span><small>${esc(a.killerName)} · #${a.position} · ${a.solved?"SOLVED":"UNSOLVED"}</small></div>`).join("");
}
async function distribute(cardId){const targetId=selectedTarget;if(!targetId){toast("Choose a detective first.");return;}const res=await emit("ghost:distribute",{cardId,targetId});if(res.ok){selectedEvidence=null;toast("Evidence delivered in silence.");}}
function renderDetective(){const p=state.pawns.find(x=>x.playerId===state.you.id);selectedSuspect=p?.position||null;$("myEvidenceCount").textContent=`${state.myEvidence.length} CARDS`;$("myEvidence").innerHTML=state.myEvidence.map(c=>`<div class="evidence-display"><img src="${asset(c.image)}" onerror="this.onerror=null;this.src='assets/evidence/placeholder.svg'"><strong>${esc(c.name)}</strong><p>${esc(c.description||"A clue from beyond.")}</p></div>`).join("")||`<p class="hint">No evidence has reached you yet.</p>`;
 $("caseStatus").innerHTML=p?.locked?"CHOICE LOCKED <span>◈</span>": "CASE UNSOLVED <span>●</span>";
 $("selectionHint").textContent=state.phase==="distribute"?"The Ghost is still distributing evidence. Study what you have received.":p?.locked?"Your choice is locked. Waiting for the others.":"Select a suspect on the board, then lock your choice.";
 $("lockSelection").disabled=state.phase!=="select"||!p?.position||p.locked||state.paused;$("lockSelection").textContent=p?.locked?"CHOICE LOCKED":"LOCK MY CHOICE  ↗";
}
function renderReveal(){const el=$("revealArea");if(state.phase!=="reveal"){el.classList.add("hidden");return;}el.classList.remove("hidden");el.innerHTML=`<h3>The veil is lifted</h3>${(state.reveal||[]).map(x=>`<div class="reveal-row"><i class="legend-dot" style="background:${x.color}"></i><span>${esc(x.name)}</span><span class="reveal-mark ${x.correct?"correct":"incorrect"}">${x.correct?"CASE SOLVED":"NOT THIS TIME"}</span></div>`).join("")}${state.you.isAdmin?`<button id="nextRound" class="primary-btn">${state.round>=state.maxRounds?"VIEW FINAL TESTIMONY":"BEGIN NEXT ROUND"} ↗</button>`:`<p class="hint">Waiting for the host to continue…</p>`}`;
 $("nextRound")?.addEventListener("click",()=>emit("game:next-round"));
}
function renderEnd(){const r=state.result;if(!r)return;$("endSymbol").textContent=r.winner==="ghost"?"☾":"✦";const won=state.you.role==="ghost"?r.winner==="ghost":(r.detectives||[]).find(d=>d.id===state.you.id)?.solved;
 $("endScreen").classList.toggle("personal-win",!!won);$("endScreen").classList.toggle("personal-loss",!won);
 $("endTitle").textContent=state.you.role==="ghost"?(won?"The séance is complete.":"The detectives uncovered the truth."):(won?"You solved your case.":"Your case remains unsolved.");
 $("endSubtitle").textContent=state.you.role==="ghost"?(won?"Your clues kept the truth hidden until the final round.":"The detectives found the answers behind your signs."):(won?"You identified your hidden culprit.":"The final testimony reveals the culprit you were seeking.");
 $("finalResults").innerHTML=`<div class="final-row"><b>THE GHOST</b><span>${esc(r.ghost||"Unknown")}</span><small>ROUNDS USED: ${r.roundsUsed}</small></div>`+r.detectives.map(d=>`<div class="final-row"><b style="color:${d.color}">${esc(d.name)}</b><span>${esc(d.killerName||"Unknown")}</span><small>${d.solved?"SOLVED":"UNSOLVED"} · ${d.correct} CORRECT · ${d.incorrect} INCORRECT</small></div>`).join("");
}
function asset(path){return typeof path==="string"&&path.startsWith("http")?path:(typeof path==="string"?path.replace(/^\//,""):"assets/evidence/placeholder.svg");}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("createRoom").onclick=createRoom;$("joinRoom").onclick=joinRoom;$("roomCode").oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"");
$("copyCode").onclick=()=>{navigator.clipboard?.writeText(state.code);toast("Room code copied.");};
$("roundOptions").onclick=e=>{const b=e.target.closest("[data-round]");if(!b||!isAdmin())return;rounds=Number(b.dataset.round);$("roundOptions").querySelectorAll("button").forEach(x=>x.classList.toggle("selected",x===b));emit("room:configure",{rounds,shuffleLimit:Number($("shuffleLimit").value),ghostId:$("ghostSelect").value});};
$("ghostSelect").onchange=()=>emit("room:configure",{rounds:state.settings.rounds,shuffleLimit:Number($("shuffleLimit").value),ghostId:$("ghostSelect").value});
$("shuffleLimit").onchange=()=>emit("room:configure",{rounds:state.settings.rounds,shuffleLimit:Number($("shuffleLimit").value),ghostId:state.ghostId});
$("startGame").onclick=()=>emit("game:start");$("closeRoom").onclick=()=>{if(confirm("Close this room for everyone?"))emit("room:close");};
$("secretToggle").onclick=()=>{$("secretAssignments").classList.toggle("hidden");$("secretToggle").innerHTML=$("secretAssignments").classList.contains("hidden")?"REVEAL SECRET ASSIGNMENTS <span>＋</span>":"HIDE SECRET ASSIGNMENTS <span>−</span>";};
$("shuffleBtn").onclick=()=>{if(confirm("Discard your current hand and draw five new evidence cards?")){selectedEvidence=null;emit("ghost:shuffle");}};
$("finishDistribution").onclick=()=>{selectedEvidence=null;emit("ghost:finish-distribution");};$("lockSelection").onclick=()=>emit("detective:lock");
$("returnHome").onclick=()=>{localStorage.removeItem("silentDeadSession");location.reload();};
$("soundToggle").onclick=()=>toggleSound();$("ambientToggle").onclick=()=>toggleSound();
function toggleSound(){soundOn=!soundOn;$("ambientToggle").textContent=soundOn?"SOUND ON":"SOUND OFF";$("soundToggle").style.color=soundOn?"#d4b77e":"#b69a68";if(soundOn)startAmbient();else stopAmbient();}
let osc=null,gain=null;
function startAmbient(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();osc=audioCtx.createOscillator();gain=audioCtx.createGain();osc.type="sine";osc.frequency.value=54;gain.gain.value=.012;osc.connect(gain);gain.connect(audioCtx.destination);osc.start();}catch(e){}}
function stopAmbient(){try{osc?.stop();osc=null;}catch(e){}}
reconnect();
