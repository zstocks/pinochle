// Sound effects. All audio concerns live here; the rest of the app just calls
// play(name). Responsibilities:
//   - preload the short clips so the first play is instant
//   - satisfy the browser autoplay policy (audio is blocked until the user has
//     interacted with the page) by priming the clips on the first gesture
//   - a mute toggle, persisted to localStorage, mounted outside the #app render
//     cycle so re-renders don't wipe it

const SOUND_NAMES = [
    "card-shuffle",   // a hand is dealt
    "card-pick",      // you select one of your cards
    "card-flip",      // anyone plays a card
    "trump-1",        // trump not led: first trump-in
    "trump-2",        // trump not led: first over-trump
    "trump-3",        // trump not led: second over-trump
    "trump-attack",   // the Trump Attack button appears
    "hand-end",       // a hand finishes
    "bid",            // a player bids
    "pass"            // a player passes
];

const MUTE_KEY = "pinochle.muted";

// One preloaded Audio per name. We clone on play so rapid repeats (e.g. several
// quick card-flips) overlap instead of cutting each other off.
const clips = {};
let muted = loadMuted();
let unlocked = false;

for (const name of SOUND_NAMES) {
    const audio = new Audio(`/sounds/${name}.mp3`);
    audio.preload = "auto";
    clips[name] = audio;
}

export function play(name) {
    if (muted) return;
    const base = clips[name];
    if (!base) return;   // unknown name — silently ignore so a missing clip can't throw
    const node = base.cloneNode();
    node.play().catch(() => { /* still blocked (no gesture yet) — ignore */ });
}

export function isMuted() {
    return muted;
}

// ----- Autoplay unlock --------------------------------------------------------

// On the first user gesture, play each clip muted then immediately reset it.
// This both satisfies the autoplay gate and warms the decode path, so the next
// real play() is instant and audible.
function unlock() {
    if (unlocked) return;
    unlocked = true;
    for (const name of SOUND_NAMES) {
        const a = clips[name];
        a.muted = true;
        a.play()
            .then(() => { a.pause(); a.currentTime = 0; a.muted = false; })
            .catch(() => { a.muted = false; });
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
}
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);

// ----- Mute toggle ------------------------------------------------------------

const btn = document.createElement("button");
btn.className = "mute-toggle";
btn.type = "button";

function refreshButton() {
    btn.textContent = muted ? "🔇" : "🔊";
    btn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    btn.setAttribute("aria-pressed", String(muted));
}

btn.addEventListener("click", () => {
    muted = !muted;
    saveMuted(muted);
    refreshButton();
});

refreshButton();
document.body.appendChild(btn);

// ----- Persistence ------------------------------------------------------------

function loadMuted() {
    try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

function saveMuted(value) {
    try { localStorage.setItem(MUTE_KEY, value ? "1" : "0"); } catch { /* private mode */ }
}
