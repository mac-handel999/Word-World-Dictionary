const btn = document.querySelector('.search-btn');
const textBody = document.querySelector('.text-body');
const url = "https://api.dictionaryapi.dev/api/v2/entries/en/";

let sound = null;

btn.addEventListener('click', () => {
  const textIn = document.querySelector('.input').value.trim();

  if (!textIn) {
    textBody.innerHTML = `<p style="text-align: center;">Please enter a word to search.</p>`;
    return;
  }

  fetch(`${url}${encodeURIComponent(textIn)}`)
    .then((response) => {
      // Handles 404 (Word not found) without throwing a JavaScript error exception
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Server status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      // If 404 occurred or empty array was returned
      if (!data || !Array.isArray(data) || data.length === 0) {
        textBody.innerHTML = `<p style="text-align: center;">No results found for "${textIn}".</p>`;
        return;
      }

      const wordData = data[0];
      
      // Extract definitions safely
      const meaning = wordData.meanings?.[0] || {};
      const definitionObj = meaning.definitions?.[0] || {};
      const partOfSpeech = meaning.partOfSpeech || 'N/A';
      const definition = definitionObj.definition || 'No definition available.';
      const example = definitionObj.example || 'No example available.';
      
      // Search for audio entry across all phonetics arrays
      const phoneticObj = wordData.phonetics?.find(p => p.audio && p.audio.trim() !== '') || {};
      const phoneticText = wordData.phonetic || wordData.phonetics?.find(p => p.text)?.text || '??';
      const phoneticAudio = phoneticObj.audio || '';

      textBody.innerHTML = `
      <div class="word-div">
        <h3 class="word-text">${wordData.word || textIn}</h3>
        
        <button onclick="playSound()" class="word-sound">
          🔊
        </button>
      </div><br>
        
      <label>Part Of Speech / Phonetics:</label>
      <br><br>
      <p class="part-of">
        <small> ${partOfSpeech} / 
          <span class="sign-text"> ${phoneticText}</span> / 
        </small>
      </p><br>
      
      <label>Meaning:</label>
      <br><br>
      <p class="meaning">${definition}</p><br>
      
      <label>Example:</label>
      <br><br>
      <p class="sentence">
        <small>${example}</small>
      </p><br>
          
      <hr><br>
      <p class="text-2" style="text-align: center;">
        <small class="search-bar">{Mac Handel Fabian Codes/}.</small>
      </p>
      <br>`;

      // Attach audio if present
      if (phoneticAudio) {
        sound = new Audio(phoneticAudio);
      } else {
        sound = null;
      }
    })
    .catch((error) => {
      // Catch handles real network dropouts/failures (e.g., disconnected internet)
      console.error('Network or system error:', error.message);
      textBody.innerHTML = `<p style="text-align: center;">Unable to connect to service. Check your internet connection.</p>`;
    });
});

function playSound() {
  if (sound) {
    sound.play().catch((err) => console.error("Audio playback error:", err));
  } else {
    alert("No audio available for this word.");
  }
}

