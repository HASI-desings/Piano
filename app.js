/**
 * PIANO MASTER - Core Game Engine
 * Features: Web Audio API, IndexedDB Offline Storage, Beat Detection
 */

// --- 1. CONFIGURATION & STATE ---
const GAME_STATE = { MENU: 0, PLAYING: 1, GAMEOVER: 2 };
let currentState = GAME_STATE.MENU;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
let width = canvas.width = window.innerWidth;
let height = canvas.height = window.innerHeight;

const LANES = 4;
let laneWidth = width / LANES;
let hitLineY = height * 0.8; 
let baseSpeed = height * 0.7; 
let speedMultiplier = 1.0; 

let score = 0, combo = 0, maxCombo = 0;
let tiles = [], particles = [];
let shakeTime = 0, redFlashAlpha = 0;

let audioCtx, currentSource, audioStartTime = 0;

const uiMenu = document.getElementById('main-menu');
const uiHud = document.getElementById('hud');
const uiGameOver = document.getElementById('game-over');
const loadingText = document.getElementById('loading-text');

// Built-in Track (Will be cached by SW)
const builtInSongs = [
    { title: "Default Track", url: "audio/default.mp3", timestamps: [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0] } // Replace timestamps with actual beats if you map them manually
];

// --- 2. INDEXED DB (OFFLINE STORAGE FOR UPLOADS) ---
const DB_NAME = 'PianoMasterDB';
const STORE_NAME = 'UserSongs';
let db;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(); };
        request.onerror = (e) => reject(e);
    });
}

function saveCustomSong(title, arrayBuffer, timestamps) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.add({ title, audioData: arrayBuffer, timestamps });
        req.onsuccess = () => resolve();
        req.onerror = () => reject();
    });
}

function getSavedSongs() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject();
    });
}

// --- 3. AUDIO & BEAT DETECTION ENGINE ---
function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

async function analyzeAudioBeats(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const timestamps = [];
    const step = Math.floor(sampleRate * 0.05); // 50ms chunks
    const threshold = 0.35; // Volume spike threshold
    let lastBeatTime = 0;

    for (let i = 0; i < channelData.length; i += step) {
        let sum = 0;
        for (let j = 0; j < step && (i + j) < channelData.length; j++) {
            sum += channelData[i + j] * channelData[i + j];
        }
        let rms = Math.sqrt(sum / step);
        const currentTimeInSec = i / sampleRate;
        
        if (rms > threshold && (currentTimeInSec - lastBeatTime > 0.25)) {
            timestamps.push(currentTimeInSec);
            lastBeatTime = currentTimeInSec;
        }
    }
    return timestamps;
}

// --- 4. GAME LOGIC ---
class Tile {
    constructor(timestamp) {
        this.timestamp = timestamp; 
        this.lane = Math.floor(Math.random() * LANES);
        this.width = laneWidth * 0.9;
        this.height = height * 0.15;
        this.active = true;
        this.x = this.lane * laneWidth + (laneWidth * 0.05);
        this.y = -this.height;
    }
    draw(currentTime) {
        if (!this.active) return;
        const timeToHit = this.timestamp - currentTime;
        this.y = hitLineY - (timeToHit * baseSpeed);
        if (this.y > -this.height && this.y < height) {
            ctx.fillStyle = '#3498db';
            ctx.beginPath();
            ctx.roundRect(this.x, this.y, this.width, this.height, 8);
            ctx.fill();
        }
        if (this.y > height && this.active) {
            this.active = false;
            triggerMiss();
        }
    }
}

class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y;
        this.vx = (Math.random() - 0.5) * 10;
        this.vy = (Math.random() - 0.5) * 10;
        this.life = 1.0;
        this.color = color;
    }
    update() {
        this.x += this.vx; this.y += this.vy;
        this.life -= 0.05;
        ctx.globalAlpha = Math.max(this.life, 0);
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }
}

async function startGame(audioBuffer, timestamps) {
    initAudio();
    currentSource = audioCtx.createBufferSource();
    currentSource.buffer = audioBuffer;
    currentSource.connect(audioCtx.destination);
    
    score = 0; combo = 0; maxCombo = 0; speedMultiplier = 1.0;
    currentSource.playbackRate.value = speedMultiplier;
    
    tiles = timestamps.map(t => new Tile(t));
    particles = [];
    
    uiMenu.classList.add('hidden');
    uiGameOver.classList.add('hidden');
    uiHud.classList.remove('hidden');
    updateHUD();

    currentState = GAME_STATE.PLAYING;
    audioStartTime = audioCtx.currentTime;
    
    currentSource.start(audioCtx.currentTime + 1);
    audioStartTime += 1; 

    currentSource.onended = () => {
        if (currentState === GAME_STATE.PLAYING) endGame();
    };
    gameLoop();
}

function handleHit(lane) {
    let trackTime = audioCtx.currentTime - audioStartTime;
    let targetTile = null, minDiff = Infinity;

    for (let t of tiles) {
        if (t.active && t.lane === lane) {
            let diff = Math.abs(t.timestamp - trackTime);
            if (diff < minDiff) { minDiff = diff; targetTile = t; }
        }
    }

    if (targetTile && minDiff < 0.3) {
        targetTile.active = false;
        score += 10 + (combo * 2);
        combo++;
        if (combo > maxCombo) maxCombo = combo;
        
        for(let i=0; i<15; i++) {
            particles.push(new Particle(targetTile.x + targetTile.width/2, hitLineY, '#2ecc71'));
        }

        if (combo % 10 === 0 && speedMultiplier < 1.5) {
            speedMultiplier += 0.05;
            currentSource.playbackRate.setValueAtTime(speedMultiplier, audioCtx.currentTime);
        }
        updateHUD();
    } else {
        triggerMiss();
    }
}

function triggerMiss() {
    shakeTime = 15; redFlashAlpha = 0.5; combo = 0;
    updateHUD();
    endGame(); // Classic mode: 1 miss ends the game
}

function endGame() {
    currentState = GAME_STATE.GAMEOVER;
    if (currentSource) { currentSource.stop(); currentSource.disconnect(); }
    uiHud.classList.add('hidden');
    uiGameOver.classList.remove('hidden');
    document.getElementById('final-score').innerText = `Score: ${score}`;
    document.getElementById('max-combo').innerText = `Max Combo: ${maxCombo}`;
}

function updateHUD() {
    document.getElementById('score').innerText = `Score: ${score}`;
    document.getElementById('combo').innerText = `Combo: x${combo}`;
}

// --- 5. RENDER LOOP ---
function gameLoop() {
    if (currentState !== GAME_STATE.PLAYING) return;
    ctx.save();
    if (shakeTime > 0) {
        ctx.translate((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
        shakeTime--;
    }

    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    for (let i = 1; i < LANES; i++) {
        ctx.beginPath(); ctx.moveTo(i * laneWidth, 0); ctx.lineTo(i * laneWidth, height); ctx.stroke();
    }

    ctx.strokeStyle = '#2ecc71';
    ctx.beginPath(); ctx.moveTo(0, hitLineY); ctx.lineTo(width, hitLineY); ctx.stroke();

    let trackTime = audioCtx.currentTime - audioStartTime;
    tiles.forEach(t => t.draw(trackTime));

    for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].update();
        if (particles[i].life <= 0) particles.splice(i, 1);
    }
    ctx.restore();

    if (redFlashAlpha > 0) {
        ctx.fillStyle = `rgba(255, 0, 0, ${redFlashAlpha})`;
        ctx.fillRect(0, 0, width, height);
        redFlashAlpha -= 0.02;
    }
    requestAnimationFrame(gameLoop);
}

// --- 6. INPUTS & INITIALIZATION ---
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (currentState !== GAME_STATE.PLAYING) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
        handleHit(Math.floor(e.changedTouches[i].clientX / laneWidth));
    }
}, { passive: false });

window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    laneWidth = width / LANES;
    hitLineY = height * 0.8;
    baseSpeed = height * 0.7;
});

// Populate Menus
async function populateUI() {
    const list = document.getElementById('song-list');
    list.innerHTML = '';
    builtInSongs.forEach(song => {
        let btn = document.createElement('button');
        btn.className = 'song-btn';
        btn.innerText = song.title;
        btn.onclick = async () => {
            initAudio(); loadingText.classList.remove('hidden');
            try {
                const response = await fetch(song.url);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                loadingText.classList.add('hidden');
                startGame(audioBuffer, song.timestamps);
            } catch (err) { alert("Error loading track. Are you offline?"); loadingText.classList.add('hidden'); }
        };
        list.appendChild(btn);
    });

    // Populate IndexedDB Custom Songs
    const savedList = document.getElementById('saved-songs-list');
    savedList.innerHTML = '';
    const savedSongs = await getSavedSongs();
    
    if (savedSongs.length === 0) {
        savedList.innerHTML = '<span style="color:#888;font-size:0.9rem;">No custom songs saved yet.</span>';
    } else {
        savedSongs.forEach(song => {
            let btn = document.createElement('button');
            btn.className = 'song-btn';
            btn.innerText = `🎵 ${song.title}`;
            btn.onclick = async () => {
                initAudio(); loadingText.classList.remove('hidden');
                try {
                    const audioBuffer = await audioCtx.decodeAudioData(song.audioData.slice(0)); // Copy buffer
                    loadingText.classList.add('hidden');
                    startGame(audioBuffer, song.timestamps);
                } catch (err) { alert("Error loading saved track."); loadingText.classList.add('hidden'); }
            };
            savedList.appendChild(btn);
        });
    }
}

// Setup System
initDB().then(populateUI).catch(console.error);

// Custom Upload Handling -> Analyzes, Saves to DB, then Plays
document.getElementById('customAudio').addEventListener('change', function(e) {
    if (e.target.files.length === 0) return;
    initAudio();
    loadingText.classList.remove('hidden');
    
    const file = e.target.files[0];
    const reader = new FileReader();

    reader.onload = async function(ev) {
        try {
            const arrayBuffer = ev.target.result;
            // Decode a copy so we can keep the original ArrayBuffer to save in DB
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0)); 
            
            const generatedTimestamps = await analyzeAudioBeats(audioBuffer);
            
            // Save completely offline in IndexedDB
            await saveCustomSong(file.name.replace(/\.[^/.]+$/, ""), arrayBuffer, generatedTimestamps);
            
            loadingText.classList.add('hidden');
            populateUI(); // Refresh UI to show the newly saved track
            startGame(audioBuffer, generatedTimestamps); // Start immediately
        } catch (err) {
            alert("Could not process audio file.");
            loadingText.classList.add('hidden');
        }
    };
    reader.readAsArrayBuffer(file);
});

document.getElementById('restart-btn').addEventListener('click', () => {
    uiGameOver.classList.add('hidden');
    uiMenu.classList.remove('hidden');
    currentState = GAME_STATE.MENU;
});

// iOS PWA Install Prompt
if (/iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase()) && !('standalone' in window.navigator && window.navigator.standalone)) {
    const prompt = document.getElementById('ios-install-prompt');
    prompt.classList.remove('hidden');
    document.getElementById('close-prompt').addEventListener('click', () => prompt.classList.add('hidden'));
}
