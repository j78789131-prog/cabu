const express=require("express");
const http=require("http");
const {Server}=require("socket.io");
const crypto=require("crypto");
const app=express(), server=http.createServer(app), io=new Server(server);
app.use(express.static("public"));
app.get("/health",(req,res)=>res.json({ok:true,service:"cabu"}));
const rooms=new Map();
const suits=["♠","♥","♦","♣"];
function deck(){const d=[];for(const s of suits)for(let n=1;n<=13;n++)d.push({n,s,id:crypto.randomUUID()});return d.sort(()=>Math.random()-.5)}
function points(c){if((c.n===13)&&(c.s==="♥"||c.s==="♦"))return -1;if(c.n===1)return 1;if(c.n>=11)return 10;return c.n}
function name(c){return (c.n===1?"A":c.n===11?"J":c.n===12?"Q":c.n===13?"K":c.n)+c.s}
function roomView(r,forId){return {code:r.code,players:r.players.map(p=>({id:p.id,name:p.name,online:p.online,score:p.score,cardCount:p.cards.length,me:p.id===forId})),phase:r.phase,turn:r.turn,discard:r.discard.at(-1)||null,deckCount:r.deck.length,round:r.round,notice:r.notice,caller:r.caller};}
function emitRoom(r){for(const p of r.players)io.to(p.id).emit("state",{...roomView(r,p.id),myCards:p.id===r.turn||r.phase==="setup"?p.cards.map(c=>({id:c.id,name:name(c),points:points(c)})):p.cards.map(()=>null)});}
function findPlayer(socket){for(const r of rooms.values()){const p=r.players.find(x=>x.id===socket.id);if(p)return [r,p]}}
function sendError(s,msg){s.emit("errorMessage",msg)}
function startRound(r){r.deck=deck();r.discard=[];r.players.forEach(p=>{p.cards=r.deck.splice(0,4);p.score=null});r.discard.push(r.deck.pop());r.phase="setup";r.turn=r.players[0].id;r.caller=null;r.notice="Peek at two of your four cards, then ready up.";emitRoom(r)}
function startPlay(r){r.phase="play";r.notice="Round started. Draw a card or take the top discard.";emitRoom(r)}
function finish(r){r.phase="finished";r.players.forEach(p=>p.score=p.cards.reduce((a,c)=>a+points(c),0));r.notice="Round over. Lowest score wins.";emitRoom(r)}
io.on("connection",socket=>{
 socket.on("createRoom",({name:playerName})=>{const nameClean=String(playerName||"").trim().slice(0,18);if(!nameClean)return sendError(socket,"Enter a nickname.");let code;do{code=crypto.randomBytes(3).toString("hex").toUpperCase()}while(rooms.has(code));const r={code,players:[],deck:[],discard:[],phase:"lobby",turn:null,round:1,notice:"Waiting for players.",caller:null};rooms.set(code,r);r.players.push({id:socket.id,name:nameClean,cards:[],online:true,score:null,ready:false});socket.join(code);socket.emit("joined",{code});emitRoom(r)});
 socket.on("joinRoom",({code,name:playerName})=>{const r=rooms.get(String(code||"").trim().toUpperCase()),nm=String(playerName||"").trim().slice(0,18);if(!r||!nm)return sendError(socket,"Room not found or nickname missing.");if(r.players.length>=6)return sendError(socket,"This room is full (6 players).");if(r.phase!=="lobby")return sendError(socket,"This round has already started.");r.players.push({id:socket.id,name:nm,cards:[],online:true,score:null,ready:false});socket.join(r.code);socket.emit("joined",{code:r.code});r.notice=nm+" joined.";emitRoom(r)});
 socket.on("startGame",()=>{const found=findPlayer(socket);if(!found)return;const [r,p]=found;if(r.players[0].id!==p.id||r.players.length<2)return sendError(socket,"The host can start with at least two players.");startRound(r)});
 socket.on("ready",()=>{const f=findPlayer(socket);if(!f)return;const [r,p]=f;if(r.phase!=="setup")return;p.ready=true;if(r.players.every(x=>x.ready))startPlay(r);else{r.notice=p.name+" is ready. Waiting for everyone.";emitRoom(r)}});
 socket.on("action",({type,cardId,index})=>{const f=findPlayer(socket);if(!f)return;const [r,p]=f;if(r.phase!=="play"||r.turn!==p.id)return sendError(socket,"It's not your turn.");if(type==="draw"){if(p.pending)return sendError(socket,"Finish your current draw first.");p.pending=r.deck.pop();if(!p.pending){r.deck=r.discard.splice(0,r.discard.length-1).sort(()=>Math.random()-.5);p.pending=r.deck.pop()}p.pending=true;r.notice=p.name+" drew a card.";emitRoom(r);socket.emit("drawn",{card:name(p.pending),id:p.pending.id});return}
 if(type==="takeDiscard"){if(p.pending)return sendError(socket,"You already drew.");p.pending=r.discard.at(-1);r.discard.pop();p.pending=true;socket.emit("drawn",{card:name(p.pending),id:p.pending.id});emitRoom(r);return}
 if(type==="exchange"&&p.pending){const i=Number(index);if(!Number.isInteger(i)||i<0||i>3)return;const old=p.cards[i];p.cards[i]=p.pending;r.discard.push(old);p.pending=null;next(r,p);return}
 if(type==="discardDrawn"&&p.pending){r.discard.push(p.pending);p.pending=null;next(r,p);return}
 if(type==="cabu"){r.caller=p.id;r.notice=p.name+" called Cabu!";r.turn=r.players[(r.players.findIndex(x=>x.id===p.id)+1)%r.players.length].id;r.finalTurns=r.players.length-1;emitRoom(r);return}
 sendError(socket,"That move is not available.")});
 function next(r,p){const i=r.players.findIndex(x=>x.id===p.id);r.turn=r.players[(i+1)%r.players.length].id;if(r.caller){r.finalTurns--;if(r.finalTurns<=0){finish(r);return}}r.notice="Next turn.";emitRoom(r)}
 socket.on("disconnect",()=>{const f=findPlayer(socket);if(!f)return;const [r,p]=f;p.online=false;r.notice=p.name+" disconnected.";emitRoom(r);if(r.players.every(x=>!x.online))rooms.delete(r.code)});
});
const port=process.env.PORT||3000;server.listen(port,"0.0.0.0",()=>console.log("Cabu listening on "+port));
