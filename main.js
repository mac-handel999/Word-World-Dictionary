const btn = document.querySelector('.search-btn');
const inputField = document.querySelector('.input');
const textBody = document.querySelector('.text-body');
const url = "https://api.dictionaryapi.dev/api/v2/entries/en/";

let sound = null;

// Trigger search on click
btn.addEventListener('click', executeSearch);

// Trigger search on "Enter" key press
inputField.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    executeSearch();
  }
});

function executeSearch() {
  const textIn = inputField.value.trim();

  if (!textIn) {
    textBody.innerHTML = `<div class="idle-state"><p>&gt; Please enter a word to search.</p></div>`;
    return;
  }

  // Show loading indicator
  textBody.innerHTML = `<div class="idle-state"><p>&gt; Querying dictionary database...</p></div>`;

  fetch(`${url}${encodeURIComponent(textIn)}`)
    .then((response) => {
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Server response error: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      if (!data || !Array.isArray(data) || data.length === 0) {
        textBody.innerHTML = `<div class="error-state"><p>&gt; No results found for "${textIn}".</p></div>`;
        return;
      }

      const wordData = data[0];
      const meaning = wordData.meanings?.[0] || {};
      const definitionObj = meaning.definitions?.[0] || {};
      const partOfSpeech = meaning.partOfSpeech || 'N/A';
      const definition = definitionObj.definition || 'No definition available.';
      const example = definitionObj.example || 'No example sentence available.';

      // Locate non-empty audio source from array
      const phoneticObj = wordData.phonetics?.find(p => p.audio && p.audio.trim() !== '') || {};
      const phoneticText = wordData.phonetic || wordData.phonetics?.find(p => p.text)?.text || '??';
      const phoneticAudio = phoneticObj.audio || '';

      // Render dictionary entry UI
      textBody.innerHTML = `
        <div class="word-header">
          <h2 class="word-title">${wordData.word || textIn}</h2>
          <button onclick="playSound()" class="sound-btn" aria-label="Play audio pronunciation">
            🔊
          </button>
        </div>

        <div class="info-group">
          <p class="info-label">Part of Speech / Phonetic</p>
          <p><span class="badge">${partOfSpeech}</span> &nbsp;<span style="color: var(--text-muted); font-family: var(--font-mono);">/${phoneticText}/</span></p>
        </div>

        <div class="info-group">
          <p class="info-label">Definition</p>
          <p class="meaning-text">${definition}</p>
        </div>

        <div class="info-group">
          <p class="info-label">Example Usage</p>
          <p class="example-text">"${example}"</p>
        </div>
      `;

      // Configure audio object safely
      if (phoneticAudio) {
        sound = new Audio(phoneticAudio);
      } else {
        sound = null;
      }
    })
    .catch((error) => {
      console.error('Error fetching dictionary data:', error.message);
      textBody.innerHTML = `<div class="error-state"><p>&gt; Connection error. Please check your network connection.</p></div>`;
    });
}

function playSound() {
  if (sound) {
    sound.play().catch((err) => console.error("Audio playback error:", err));
  } else {
    alert("No audio pronunciation available for this entry.");
  }
}
