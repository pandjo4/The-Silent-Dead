
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

const DATA_DIR = path.join(__dirname, "..", "public", "data");
const suspects = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "suspects.json"), "utf8"));
const evidence = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "evidence.json"), "utf8"));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: process.env.NODE_ENV === "production" ? "1h" : 0, etag: true }));
app.get("/health", (_, res) => res.json({ ok: true, rooms: rooms.size }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/socket.io/") || req.path.startsWith("/health")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
function validateDatabase(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} database must be a JSON array.`);
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error(`${label} entries need a non-empty id.`);
    if (ids.has(item.id)) throw new Error(`Duplicate ${label.toLowerCase()} id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.name !== "string" || !item.name.trim()) throw new Error(`${label} entry ${item.id} needs a name.`);
    if (typeof item.image !== "string" || !item.image.trim()) throw new Error(`${label} entry ${item.id} needs an image path.`);
    const imagePath = path.resolve(PUBLIC_DIR, item.image.replace(/^\/+/, ""));
    if (!imagePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(imagePath)) {
      throw new Error(`${label} image is missing or outside public/: ${item.image}`);
    }
  }
}
validateDatabase(suspects, "Suspects");
validateDatabase(evidence, "Evidence");
const rooms = new Map();
const COLORS = ["#65a9e8","#b18be7","#e5c56c","#69c9c8","#e49a62","#d47f9d"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const uid = () => crypto.randomBytes(16).toString("hex");
const clampInt = (value,min,max,fallback) => { const n=Number(value); return Number.isInteger(n)?Math.max(min,Math.min(max,n)):fallback; };
const pick = arr => arr[Math.floor(Math.random()*arr.length)];
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const safeName = s => String(s||"Player").trim().replace(/[<>]/g,"").slice(0,18) || "Player";
function makeCode(){ let c; do { c=""; for(let i=0;i<5;i++) c+=pick(CODE_CHARS); } while(rooms.has(c)); return c; }
function roomFor(socket){ const r=rooms.get(socket.data.room); if(!r) throw Error("Room not found."); return r; }
function playerFor(r,socket){ const p=r.players.find(x=>x.id===socket.data.playerId); if(!p) throw Error("Player not found."); return p; }
function emitError(socket,msg){ socket.emit("game:error",{message:msg}); }
function publicState(r){
  return { code:r.code, adminId:r.adminId, ghostId:r.ghostId, settings:r.settings, phase:r.phase, round:r.round, maxRounds:r.settings.rounds,
    players:r.players.map(p=>({id:p.id,name:p.name,color:p.color,connected:p.connected,role:p.role,solved:p.solved,active:p.role==="detective"&&!p.solved})),
    board:r.board.map((s,i)=>({id:s.id,name:s.name,image:s.image,position:i+1,eliminated:r.players.some(p=>p.role==="detective"&&p.solved&&p.killerId===s.id)})),
    pawns:r.players.filter(p=>p.role==="detective").map(p=>({playerId:p.id,name:p.name,color:p.color,position:p.selection,locked:p.locked,solved:p.solved})),
    distribution:{phase:r.distributionPhase,counts:r.distributionCounts,shuffleRemaining:r.shuffleRemaining},
    reveal:r.reveal, result:r.result, paused:r.paused, pauseReason:r.pauseReason };
}
function privateState(r,p){
  const base={...publicState(r),you:{id:p.id,name:p.name,role:p.role,isAdmin:p.id===r.adminId}};
  if(p.role==="ghost"){
    base.secretAssignments=r.players.filter(x=>x.role==="detective").map(x=>({playerId:x.id,name:x.name,color:x.color,killerId:x.killerId,killerName:r.board.find(s=>s.id===x.killerId)?.name,position:r.board.findIndex(s=>s.id===x.killerId)+1,solved:x.solved,connected:x.connected}));
    base.hand=r.ghostHand.map(id=>evidence.find(e=>e.id===id)).filter(Boolean);
  } else {
    base.myEvidence=p.evidence.map(id=>evidence.find(e=>e.id===id)).filter(Boolean);
  }
  return base;
}
function broadcast(r){
  for(const p of r.players){ if(p.socketId){ const s=io.sockets.sockets.get(p.socketId); if(s) s.emit("game:state",privateState(r,p)); } }
}
function phaseError(r, expected){ if(r.paused) throw Error("The game is paused while a player reconnects."); if(r.phase!==expected) throw Error("That action is not available right now."); }
function finishGame(r,ghostWins){
  r.phase="finished";
  r.result={winner:ghostWins?"ghost":"detectives",winnerLabel:ghostWins?"THE GHOST":"THE DETECTIVES",roundsUsed:r.round,
    detectives:r.players.filter(p=>p.role==="detective").map(p=>({id:p.id,name:p.name,color:p.color,killerId:p.killerId,killerName:r.board.find(s=>s.id===p.killerId)?.name,solved:p.solved,correct:p.correct,incorrect:p.incorrect})),
    ghost:r.players.find(p=>p.role==="ghost")?.name};
}
function startRound(r){
  r.phase="distribute";
  r.distributionPhase=1;
  r.distributionCounts={1:0,2:0};
  r.discardedEvidence=[];
  // Clear the previous round before drawing, so its cards can be recycled if needed.
  r.players.filter(p=>p.role==="detective").forEach(p=>{
    p.evidence=[];
    p.selection=null;
    p.locked=false;
  });
  r.ghostHand=drawCards(r,5);
  r.reveal=null;
  r.paused=false;
  r.pauseReason="";
}
function drawCards(r,n){
  let out=[];
  for(let i=0;i<n;i++){
    if(r.deck.length===0){
      // Recycle only cards from completed rounds; never cards currently in the Ghost's hand.
      const held=new Set(r.ghostHand||[]);
      const circulating=new Set(r.players.flatMap(p=>p.evidence||[]));
      const discarded=new Set(r.discardedEvidence||[]);
      const alreadyDrawn=new Set(out);
      const pool=evidence.map(e=>e.id).filter(id=>!held.has(id)&&!circulating.has(id)&&!discarded.has(id)&&!alreadyDrawn.has(id));
      if(!pool.length) break;
      r.deck=shuffle(pool);
    }
    const id=r.deck.pop(); if(id && !out.includes(id) && !r.ghostHand.includes(id) && !r.players.some(p=>(p.evidence||[]).includes(id))) out.push(id);
  }
  return out;
}
function createGame(r){
  const ghost=r.players.find(p=>p.id===r.ghostId);
  const detectives=r.players.filter(p=>p.id!==r.ghostId);
  if(!ghost || detectives.length<1) throw Error("Choose one Ghost and at least one Detective.");
  if(suspects.length<9) throw Error("At least 9 valid suspects are required.");
  if(evidence.length<10) throw Error("At least 10 evidence cards are required to run both distribution phases.");
  r.board=shuffle(suspects).slice(0,9);
  const killers=shuffle(r.board.map(s=>s.id)).slice(0,detectives.length);
  detectives.forEach((p,i)=>{p.role="detective";p.killerId=killers[i];p.solved=false;p.correct=0;p.incorrect=0;p.evidence=[];p.selection=null;p.locked=false;});
  ghost.role="ghost"; ghost.killerId=null;
  r.deck=shuffle(evidence.map(e=>e.id)); r.ghostHand=[];r.discardedEvidence=[];r.shuffleRemaining=r.settings.shuffleLimit;r.round=1;r.result=null;
  startRound(r);
}
function cleanRoom(r){
  if (r.players.every(p=>!p.connected)) {
    if (r.cleanupTimer) clearTimeout(r.cleanupTimer);
    r.cleanupTimer=setTimeout(()=>{
      const current=rooms.get(r.code);
      if(current===r && r.players.every(p=>!p.connected)) rooms.delete(r.code);
    },10*60*1000);
    r.cleanupTimer.unref?.();
  } else if (r.cleanupTimer) {
    clearTimeout(r.cleanupTimer);
    r.cleanupTimer=null;
  }
}
io.on("connection", socket => {
  socket.on("room:create",(payload={},ack=()=>{})=>{
    try{
      const code=makeCode(), id=uid(), token=uid();
      const p={id,name:safeName(payload.name),color:COLORS[0],role:"unassigned",connected:true,socketId:socket.id,token,evidence:[],solved:false};
      const r={code,adminId:id,players:[p],settings:{rounds:clampInt(payload.rounds,1,6,4),shuffleLimit:clampInt(payload.shuffleLimit,0,5,3)},phase:"lobby",round:0,ghostId:null,board:[],deck:[],ghostHand:[],shuffleRemaining:3,distributionPhase:1,distributionCounts:{1:0,2:0},reveal:null,result:null,paused:false,pauseReason:"",cleanupTimer:null};
      rooms.set(code,r);socket.data.room=code;socket.data.playerId=id;ack({ok:true,code,playerId:id,token,state:privateState(r,p)});broadcast(r);
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("room:join",(payload={},ack=()=>{})=>{
    try{
      const code=String(payload.code||"").toUpperCase().trim(),r=rooms.get(code);if(!r)throw Error("Room code not found.");
      if(r.phase!=="lobby")throw Error("This game has already started.");
      if(r.players.length>=6)throw Error("This room is full.");
      const id=uid(),token=uid(),p={id,name:safeName(payload.name),color:COLORS[r.players.length]||pick(COLORS),role:"unassigned",connected:true,socketId:socket.id,token,evidence:[],solved:false};
      r.players.push(p);socket.data.room=code;socket.data.playerId=id;ack({ok:true,code,playerId:id,token,state:privateState(r,p)});broadcast(r);
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("room:reconnect",(payload={},ack=()=>{})=>{
    try{
      const r=rooms.get(String(payload.code||"").toUpperCase()),p=r?.players.find(x=>x.id===payload.playerId&&x.token===payload.token);
      if(!r||!p)throw Error("Reconnect details are invalid or the room has expired.");
      if(p.socketId){const old=io.sockets.sockets.get(p.socketId);if(old&&old.id!==socket.id)old.disconnect(true);}
      p.socketId=socket.id;p.connected=true;
      if(r.cleanupTimer){clearTimeout(r.cleanupTimer);r.cleanupTimer=null;}
      socket.data.room=r.code;socket.data.playerId=p.id;
      // Resume only after every player has reconnected. A Ghost reconnecting must
      // not unpause the room while another Detective is still offline.
      if(r.paused && r.players.every(x=>x.connected)){r.paused=false;r.pauseReason="";}
      ack({ok:true,code:r.code,playerId:p.id,token:p.token,state:privateState(r,p)});broadcast(r);
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("room:configure",(payload={},ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.id!==r.adminId)throw Error("Only the room admin can change settings.");if(r.phase!=="lobby")throw Error("The game has already started.");
      r.settings.rounds=clampInt(payload.rounds,1,6,r.settings.rounds);r.settings.shuffleLimit=clampInt(payload.shuffleLimit,0,5,r.settings.shuffleLimit);if(payload.ghostId && r.players.some(x=>x.id===payload.ghostId))r.ghostId=payload.ghostId;broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("room:kick",(payload={},ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.id!==r.adminId)throw Error("Only the admin can remove players.");if(r.phase!=="lobby")throw Error("Players cannot be removed after starting.");
      const target=r.players.find(x=>x.id===payload.playerId);if(!target||target.id===r.adminId)throw Error("Invalid player.");if(target.socketId)io.to(target.socketId).emit("room:removed");r.players=r.players.filter(x=>x.id!==target.id);broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("room:close",(_,ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.id!==r.adminId)throw Error("Only the admin can close the room.");r.players.forEach(x=>x.socketId&&io.to(x.socketId).emit("room:removed"));if(r.cleanupTimer)clearTimeout(r.cleanupTimer);rooms.delete(r.code);ack({ok:true});}
    catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("game:start",(_,ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.id!==r.adminId)throw Error("Only the admin can start.");if(r.phase!=="lobby")throw Error("Game already started.");if(r.players.length<2)throw Error("At least two players are required.");if(!r.ghostId||!r.players.some(x=>x.id===r.ghostId))throw Error("Select exactly one Ghost.");
      if(r.players.some(x=>!x.connected)) throw Error("Every player must be connected before the game can start.");
      createGame(r);broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("ghost:distribute",(payload={},ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.role!=="ghost")throw Error("Only the Ghost can distribute evidence.");phaseError(r,"distribute");
      const cardId=payload.cardId,target=r.players.find(x=>x.id===payload.targetId&&x.role==="detective"&&!x.solved);
      if(!target)throw Error("Choose an active Detective.");if(!r.ghostHand.includes(cardId))throw Error("That card is not in your hand.");
      target.evidence.push(cardId);r.ghostHand=r.ghostHand.filter(x=>x!==cardId);r.distributionCounts[r.distributionPhase]++;
      broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("ghost:finish-distribution",(_,ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.role!=="ghost")throw Error("Only the Ghost can finish distribution.");phaseError(r,"distribute");
      if(r.distributionCounts[r.distributionPhase]<1)throw Error("Distribute at least one evidence card before finishing this phase.");
      if(r.distributionPhase===1){r.distributionPhase=2;r.ghostHand=drawCards(r,5);}else{r.phase="select";r.ghostHand=[];}
      broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("ghost:shuffle",(_,ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.role!=="ghost")throw Error("Only the Ghost can shuffle.");phaseError(r,"distribute");if(r.shuffleRemaining<=0)throw Error("No card replacements remain.");
      const previousHand=[...r.ghostHand];
      const previousDiscard=[...r.discardedEvidence];
      r.discardedEvidence.push(...previousHand);
      r.ghostHand=[];
      const nextHand=drawCards(r,5);
      if(nextHand.length===0){
        r.discardedEvidence=previousDiscard;
        r.ghostHand=previousHand;
        throw Error("No fresh evidence cards remain in the deck.");
      }
      r.ghostHand=nextHand;
      r.shuffleRemaining--;
      broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("detective:select",(payload={},ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.role!=="detective"||p.solved)throw Error("You cannot select a suspect.");phaseError(r,"select");if(p.locked)throw Error("Your selection is locked.");
      const pos=Number(payload.position);if(!Number.isInteger(pos)||pos<1||pos>9)throw Error("Choose a position from 1 to 9.");if(r.players.some(x=>x.role==="detective"&&x.solved&&x.killerId===r.board[pos-1].id))throw Error("That suspect has already been eliminated.");
      p.selection=pos;p.locked=false;broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("detective:lock",(_,ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.role!=="detective"||p.solved)throw Error("You cannot lock a selection.");phaseError(r,"select");if(!p.selection)throw Error("Choose a suspect first.");p.locked=true;
      const active=r.players.filter(x=>x.role==="detective"&&!x.solved);if(active.every(x=>x.locked)){
        r.phase="reveal";r.reveal=active.map(x=>{const chosen=r.board[x.selection-1],correct=chosen.id===x.killerId;if(correct){x.solved=true;x.correct++;}else{x.incorrect++;}return {playerId:x.id,name:x.name,color:x.color,position:x.selection,correct,solved:x.solved};});
        if(r.players.filter(x=>x.role==="detective").every(x=>x.solved))finishGame(r,false);
        else if(r.round>=r.settings.rounds)finishGame(r,true);
      }
      broadcast(r);ack({ok:true});
    }catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("game:next-round",(_,ack=()=>{})=>{
    try{const r=roomFor(socket),p=playerFor(r,socket);if(p.id!==r.adminId)throw Error("Only the admin can continue.");if(r.phase!=="reveal")throw Error("The reveal is not complete.");if(r.paused)throw Error("The game is paused while a player reconnects.");if(r.players.every(x=>x.role!=="detective"||x.solved))finishGame(r,false);else{r.round++;startRound(r);}broadcast(r);ack({ok:true});}
    catch(e){ack({ok:false,message:e.message});}
  });
  socket.on("disconnect",()=>{
    const r=rooms.get(socket.data.room);if(!r)return;const p=r.players.find(x=>x.id===socket.data.playerId);
    // Ignore disconnect events from an older socket replaced during reconnection.
    if(!p || p.socketId!==socket.id)return;
    p.connected=false;p.socketId=null;
    if(r.phase!=="lobby"&&r.phase!=="finished"){r.paused=true;r.pauseReason=`${p.name} disconnected. Waiting for reconnection.`;}
    broadcast(r);cleanRoom(r);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,"0.0.0.0",()=>console.log(`THE SILENT DEAD server listening on ${PORT}`));
