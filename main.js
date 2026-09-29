/* =============================================================================
 * Word World || Cybernetic Lexicon Engine
 * main.js - multi-source dictionary client (no API keys required)
 *
 * Sources, merged in parallel:
 *   1. dictionaryapi.dev  (dictionaryapi.dev API v2)  - meanings + audio
 *   2. Wiktionary MediaWiki API                       - IPA / enPR / audio /
 *                                                          etymology / senses
 *   3. Wiktionary REST v1                             - clean sense fallback
 *   4. Datamuse                                         - frequency / ARPAbet /
 *                                                          synonyms / antonyms
 *
 * Every source is optional: the UI degrades gracefully to whatever responds.
 * ========================================================================== */

/* ---------------------------------------------------------------- constants */

const ENDPOINTS = {
  dictionaryApi: (word) => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  wiktionaryRest: (word) => `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
  wiktionaryParse: (word) =>
    'https://en.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2&prop=text&redirects=1&origin=*&page=' +
    encodeURIComponent(word),
  datamuse: (word) => `https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=dpran&max=1`,
  datamuseRelated: (word, rel) => `https://api.datamuse.com/words?${rel}=${encodeURIComponent(word)}&max=10`
};

const REQUEST_TIMEOUT = 12000;
const REQUEST_TIMEOUT_SHORT = 5000;
const HISTORY_KEY = 'wordworld:history';
const HISTORY_LIMIT = 8;

const POS_KEYS = [
  'propernoun', 'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition',
  'conjunction', 'interjection', 'determiner', 'article', 'numeral', 'particle',
  'phrasalverb', 'adjectivalnoun', 'adverbialphrase', 'contraction', 'abbreviation',
  'classifier', 'idiom', 'proverb', 'phrase', 'prefix', 'suffix', 'infix', 'root',
  'letter', 'symbol'
];

const DATAMUSE_POS = {
  n: 'noun', npl: 'noun', np: 'proper noun', v: 'verb', vb: 'verb', vd: 'verb',
  vbl: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition',
  conj: 'conjunction', pron: 'pronoun', int: 'interjection', det: 'determiner',
  abbr: 'abbreviation', prep_phrase: 'prepositional phrase', adv_phrase: 'adverbial phrase'
};

/* ------------------------------------------------------------- html helpers */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-',
  mdash: '-', hellip: '...', shy: '', thinsp: ' ', minus: '-', times: 'x'
};

function decodeEntities(input) {
  return String(input || '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const value = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return match;
      try {
        return String.fromCodePoint(value);
      } catch (err) {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripHtml(html) {
  return decodeEntities(
    String(html == null ? '' : html)
      .replace(/<(script|style|math)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|dd|dt|tr|ul|ol|dl|section|h[1-6])>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[\u200e\u200f\u00a0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function unique(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = typeof item === 'string' ? item.toLowerCase() : JSON.stringify(item);
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------- wikitext heuristics */

function splitHeadings(html, tagPattern) {
  const re = new RegExp(`<h[${tagPattern}]\\b[^>]*id="([^"]+)"[^>]*>([\\s\\S]*?)</h[${tagPattern}]>`, 'gi');
  const sections = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    sections.push({
      id: match[1],
      title: stripHtml(match[2]),
      start: match.index,
      contentStart: re.lastIndex
    });
  }
  sections.forEach((section, index) => {
    section.end = index + 1 < sections.length ? sections[index + 1].start : html.length;
    section.html = html.slice(section.contentStart, section.end);
  });
  return sections;
}

function blockElements(html, tag) {
  const any = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  const blocks = [];
  let depth = 0;
  let start = -1;
  let match;
  while ((match = any.exec(html)) !== null) {
    if (match[0][1] === '/') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1) {
        const end = match.index + match[0].length;
        blocks.push({ start, end, html: html.slice(start, end) });
        start = -1;
      }
    } else {
      if (depth === 0) start = match.index;
      depth += 1;
    }
  }
  return blocks;
}

function listItems(html) {
  const items = [];
  const re = /<li\b[^>]*>|<\/li>/gi;
  let depth = 0;
  let start = -1;
  let match;
  while ((match = re.exec(html)) !== null) {
    const closing = match[0].slice(1, 2) === '/';
    if (closing) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1) {
        items.push(html.slice(start, match.index + match[0].length));
        start = -1;
      }
    } else {
      if (depth === 0) start = match.index;
      depth += 1;
    }
  }
  return items;
}

function withoutBlocks(html, tag) {
  let out = html;
  blockElements(html, tag).forEach((block) => {
    out = out.slice(0, block.start) + ' ' + out.slice(block.end);
  });
  return out;
}

function cleanExample(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const quoted = value.match(/["“]([^"”]{3,})["”]/g);
  if (quoted && quoted.length) {
    const last = quoted[quoted.length - 1];
    const inner = last.replace(/^["“]|["”]$/g, '').trim();
    if (inner.length >= 8) return inner;
  }
  return value.replace(/^\d[\d\s–—-]*,/, '').trim();
}

function matchAll(regex, html) {
  return Array.from(String(html || '').matchAll(regex));
}

function posKeyFromId(id) {
  return String(id || '').toLowerCase().replace(/_\d+$/, '').replace(/[^a-z]/g, '');
}

function isPartOfSpeech(id) {
  return POS_KEYS.indexOf(posKeyFromId(id)) !== -1;
}

function titleCase(value) {
  return String(value || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/* -------------------------------------------------------- wiktionary parsing */

function englishRegion(html) {
  const languages = splitHeadings(html, '2');
  const english = languages.find((section) => section.title.trim().toLowerCase() === 'english');
  if (!english) return '';
  const next = languages[languages.indexOf(english) + 1];
  return html.slice(english.start, next ? next.start : html.length);
}

function parsePronunciation(html) {
  const section = splitHeadings(html, '34').find((s) => /^pronunciation/i.test(s.id.replace(/_/g, '')));
  const source = section ? section.html : html;
  const result = { ipa: [], enpr: [], arpabet: [], audio: [], rhymes: [] };

  const ipaRe = /<span class="IPA[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  const rhymeSegments = matchAll(/<li\b[^>]*>\s*Rhymes?:[\s\S]*?<\/li>/gi, source).map((m) => m[0]);
  rhymeSegments.forEach((segment) => {
    matchAll(ipaRe, segment)
      .map((m) => stripHtml(m[1]).replace(/^-|-$/g, ''))
      .filter(Boolean)
      .forEach((value) => result.rhymes.push(value));
  });
  const ipaSource = rhymeSegments.length ? source.split(rhymeSegments.join(' ')).join(' ') : source;
  unique(matchAll(ipaRe, ipaSource).map((m) => stripHtml(m[1])))
    .filter(Boolean)
    .forEach((value) => {
      // Some pages render the rhyme line as "-rhyme-" inside the IPA list.
      if (/^-[\p{L}ˈˌː]+-$/u.test(value)) result.rhymes.push(value.replace(/^-|-$/g, ''));
      else result.ipa.push(value);
    });

  unique(matchAll(/<span class="AHD enPR"[^>]*>([\s\S]*?)<\/span>/gi, source).map((m) => stripHtml(m[1])))
    .filter(Boolean)
    .forEach((value) => result.enpr.push(value));

  matchAll(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi, source).forEach((match) => {
    const attributes = match[1];
    const inner = match[2];
    const sources = matchAll(/<source\b[^>]*>/gi, inner).map((m) => m[0]);
    const preferred = sources.find((s) => /audio\/mpeg|mp3/i.test(s)) || sources[0];
    if (!preferred) return;
    let url = (preferred.match(/\bsrc="([^"]+)"/i) || [])[1];
    if (!url) return;
    if (url.startsWith('//')) url = `https:${url}`;
    const fileName = (attributes.match(/data-mwtitle="([^"]+)"/i) || [])[1] || '';

    const rowStart = source.lastIndexOf('<tr', match.index);
    const rowEnd = source.indexOf('</tr>', match.index);
    let label = '';
    if (rowStart !== -1 && rowEnd > match.index) {
      const row = source.slice(rowStart, rowEnd);
      const accents = unique(
        matchAll(/<span class="(?:usage-label-accent|ib-content label-content)"[^>]*>([\s\S]*?)<\/span>/gi, row)
          .map((m) => stripHtml(m[1]))
          .filter(Boolean)
      );
      label = accents.join(' ').replace(/^Audio\s*/i, '').replace(/[:;,)\s]+$/, '').trim();
    }
    if (!label && fileName) {
      const prefix = (fileName.match(/^En-([a-z]+)-/i) || [])[1] || '';
      label = prefix ? prefix.toUpperCase() : 'Pronunciation';
    }

    let accent = '';
    if (/\b(uk|british|rp)\b/i.test(label) || /-uk-|-british/i.test(fileName)) accent = 'UK';
    else if (/\b(us|american|general american|ga)\b/i.test(label) || /-us-|-american/i.test(fileName)) accent = 'US';

    const type = /\bmpeg|mp3/i.test(preferred) ? 'audio/mpeg' : 'audio/ogg';
    result.audio.push({ url, label: label || 'Audio', accent, type, file: fileName });
  });

  return result;
}

function parseNyms(html) {
  const result = { synonyms: [], antonyms: [] };
  ['synonym', 'antonym'].forEach((kind) => {
    let index = html.indexOf(`nyms ${kind}`);
    while (index !== -1) {
      const end = html.indexOf('</dd>', index);
      const segment = html.slice(index, end === -1 ? html.length : end);
      matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, segment).forEach((m) => {
        const word = stripHtml(m[1]);
        if (/^Thesaurus:/i.test(word) || /^Category:/i.test(word) || /^Wiktionary:/i.test(word)) return;
        if (!/^[\p{L}][\p{L}' -]{0,28}$/u.test(word)) return;
        result[kind === 'synonym' ? 'synonyms' : 'antonyms'].push(word);
      });
      index = html.indexOf(`nyms ${kind}`, index + 1);
    }
  });
  return result;
}

function spansWithClass(html, className) {
  const re = new RegExp(`<([a-z]+)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  return matchAll(re, html).map((m) => stripHtml(m[2])).filter(Boolean);
}

function stripInlineRelations(text) {
  return String(text || '')
    .replace(/\s*(Synonyms?|Antonyms?)\s*:\s*[^.;]*(?:[.;]|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseDefinitionItem(itemHtml) {
  const dlBlocks = blockElements(itemHtml, 'dl');
  const ulBlocks = blockElements(itemHtml, 'ul');

  const nyms = { synonyms: [], antonyms: [] };
  const examples = [];
  dlBlocks.forEach((block) => {
    const found = parseNyms(block.html);
    nyms.synonyms = nyms.synonyms.concat(found.synonyms);
    nyms.antonyms = nyms.antonyms.concat(found.antonyms);
    examples.push(...spansWithClass(block.html, 'e-example'));
  });
  ulBlocks.forEach((block) => {
    const quotations = spansWithClass(block.html, 'e-quotation');
    if (quotations.length) {
      examples.push(...quotations);
    } else {
      listItems(block.html).forEach((li) => {
        const text = stripInlineRelations(stripHtml(li));
        if (text && text.length > 12) examples.push(text);
      });
    }
  });

  // Remove from the end so earlier offsets stay valid.
  dlBlocks.concat(ulBlocks)
    .sort((a, b) => b.start - a.start)
    .forEach((block) => {
      itemHtml = itemHtml.slice(0, block.start) + ' ' + itemHtml.slice(block.end);
    });

  const definition = stripInlineRelations(stripHtml(itemHtml)).replace(/^\d+\s*[.)]\s*/, '').trim();
  const cleaned = unique(examples).map(cleanExample).filter(Boolean);

  return {
    definition,
    example: cleaned[0] || '',
    examples: cleaned.slice(0, 3),
    synonyms: unique(nyms.synonyms),
    antonyms: unique(nyms.antonyms)
  };
}

function cleanLabel(html) {
  return stripInlineRelations(stripHtml(html))
    .replace(/^\d+\s*[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[:;,]\s*$/, '')
    .trim();
}

function collectDefinitions(listHtml, groupLabel) {
  const out = [];
  listItems(listHtml).forEach((li) => {
    const nested = blockElements(li, 'ol');
    const own = nested.length ? cleanLabel(withoutBlocks(li, 'ol')) : cleanLabel(li);

    if (nested.length) {
      // A nested list means this <li> is a sense-group heading or a gloss line
      // that owns sub-senses. Keep it as context, not as a sense of its own.
      const label = own && own.length < 200 ? own : groupLabel;
      nested.forEach((block) => {
        collectDefinitions(block.html, label).forEach((item) => out.push(item));
      });
      return;
    }

    if (!own) return;
    const item = parseDefinitionItem(li);
    if (!item.definition) return;
    out.push(prefixDefinition(item, groupLabel));
  });
  return out;
}

function prefixDefinition(item, groupLabel) {
  if (groupLabel && !/^\(/.test(item.definition)) {
    item.definition = `${groupLabel}: ${item.definition}`;
  }
  return item;
}

function classifySection(id) {
  const normalized = String(id || '').replace(/_/g, '');
  if (/^pronunciation/i.test(normalized)) return 'pronunciation';
  if (/^etymology/i.test(normalized)) return 'etymology';
  if (/^alternative_?forms$/i.test(normalized)) return 'forms';
  if (/^hyphenation$/i.test(normalized)) return 'hyphenation';
  if (isPartOfSpeech(id)) return 'pos';
  return 'other';
}

function parseWiktionaryHtml(html) {
  if (!html) return null;
  const region = englishRegion(html);
  if (!region) return null;

  const sections = splitHeadings(region, '34');
  const entry = {
    meanings: [],
    pronunciation: { ipa: [], enpr: [], arpabet: [], audio: [], rhymes: [] },
    etymology: [],
    forms: [],
    hyphenation: ''
  };
  const byKey = new Map();
  let currentEtymology = '';

  sections.forEach((section) => {
    const kind = classifySection(section.id);

    if (kind === 'etymology') {
      const text = stripInlineRelations(stripHtml(blockElements(section.html, 'p')[0]?.html || section.html));
      if (text) {
        currentEtymology = text;
        if (entry.etymology.indexOf(text) === -1) entry.etymology.push(text);
      }
      return;
    }
    if (kind === 'forms') {
      blockElements(section.html, 'ul').forEach((block) => {
        listItems(block.html).forEach((li) => {
          const link = (li.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i) || [])[1];
          const word = stripHtml(link || li).split('(')[0].trim();
          if (word && /^[\p{L}' -]{1,40}$/u.test(word)) entry.forms.push(word);
        });
      });
      return;
    }
    if (kind === 'hyphenation') {
      entry.hyphenation = stripHtml(section.html);
      return;
    }
    if (kind === 'pronunciation') {
      const parsed = parsePronunciation(section.html);
      entry.pronunciation.ipa.push(...parsed.ipa);
      entry.pronunciation.enpr.push(...parsed.enpr);
      entry.pronunciation.rhymes.push(...parsed.rhymes);
      entry.pronunciation.audio.push(...parsed.audio);
      return;
    }
    if (kind !== 'pos') return;

    const key = posKeyFromId(section.id);
    const forms = unique(
      matchAll(/<b\b[^>]*class="[^"]*form-of[^"]*"[^>]*>([\s\S]*?)<\/b>/gi, section.html)
        .map((m) => stripHtml(m[1]))
        .filter((word) => word && word.length < 40 && !/\(/.test(word))
    );
    const ordered = blockElements(section.html, 'ol');
    const definitions = collectDefinitions(ordered.length ? ordered[0].html : '');
    if (!definitions.length && !forms.length) return;

    let meaning = byKey.get(key);
    if (!meaning) {
      meaning = {
        partOfSpeech: titleCase(key),
        key,
        source: 'Wiktionary',
        forms: [],
        definitions: [],
        etymology: currentEtymology
      };
      byKey.set(key, meaning);
      entry.meanings.push(meaning);
    } else if (currentEtymology && !meaning.etymology) {
      meaning.etymology = currentEtymology;
    }
    meaning.forms = unique(meaning.forms.concat(forms));
    const seen = new Set(meaning.definitions.map((item) => item.definition.toLowerCase()));
    definitions.forEach((item) => {
      if (seen.has(item.definition.toLowerCase())) return;
      seen.add(item.definition.toLowerCase());
      meaning.definitions.push(item);
    });
  });

  entry.forms = unique(entry.forms);
  entry.etymology = entry.etymology.map((text) => text.slice(0, 900));
  return entry;
}

/* ------------------------------------------------------------ network layer */

function fetchJson(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || REQUEST_TIMEOUT);
  // Wikimedia asks API clients to identify themselves; browsers forbid a custom
  // User-Agent, but Api-User-Agent is allowed and prevents throttling.
  const headers = { Accept: 'application/json' };
  if (url.indexOf('wiktionary.org') !== -1) headers['Api-User-Agent'] = 'WordWorldDictionary/1.0';
  return fetch(url, { signal: controller.signal, headers })
    .then((response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .finally(() => clearTimeout(timer));
}

function fetchDictionaryApi(word) {
  return fetchJson(ENDPOINTS.dictionaryApi(word), REQUEST_TIMEOUT_SHORT)
    .then((data) => {
      if (!Array.isArray(data) || !data.length) return null;
      const meanings = [];
      data.forEach((entry) => {
        (entry.meanings || []).forEach((meaning) => {
          meanings.push({
            partOfSpeech: meaning.partOfSpeech || 'Unspecified',
            key: posKeyFromId(meaning.partOfSpeech) || 'unspecified',
            source: 'dictionaryapi.dev',
            definitions: (meaning.definitions || [])
              .map((definition) => ({
                definition: definition.definition || '',
                example: definition.example || '',
                examples: definition.example ? [definition.example] : [],
                synonyms: definition.synonyms || [],
                antonyms: definition.antonyms || []
              }))
              .filter((item) => item.definition)
          });
        });
      });
      const audio = [];
      data.forEach((entry) => {
        (entry.phonetics || []).forEach((phonetic) => {
          if (phonetic.audio && phonetic.audio.trim()) {
            audio.push({ url: phonetic.audio, label: entry.sourceUrls?.[0] ? 'dictionaryapi.dev' : 'Audio', accent: '', type: '', file: '' });
          }
        });
      });
      const ipa = unique(data.map((entry) => entry.phonetic).filter(Boolean));
      return {
        source: 'dictionaryapi.dev',
        meanings,
        pronunciation: { ipa, enpr: [], arpabet: [], audio: unique(audio.map((a) => JSON.stringify(a))).map(JSON.parse), rhymes: [] },
        synonyms: unique((data[0].synonyms || [])),
        antonyms: unique((data[0].antonyms || []))
      };
    })
    .catch(() => null);
}

function fetchWiktionary(word) {
  const loadParse = () =>
    fetchJson(ENDPOINTS.wiktionaryParse(word))
      .catch(() => null)
      .then((first) => {
        if (first) return first;
        return new Promise((resolve) => { setTimeout(resolve, 400); })
          .then(() => fetchJson(ENDPOINTS.wiktionaryParse(word)).catch(() => null))
          .then((second) => {
            if (second) return second;
            return new Promise((resolve) => { setTimeout(resolve, 1200); })
              .then(() => fetchJson(ENDPOINTS.wiktionaryParse(word)).catch(() => null));
          });
      });

  return loadParse().then((parsed) => {
    let result = null;
    let canonical = word;
    if (parsed && parsed.parse && parsed.parse.text) {
      result = parseWiktionaryHtml(parsed.parse.text);
      if (result) {
        result.source = 'Wiktionary';
        result.meanings.forEach((meaning) => { meaning.source = 'Wiktionary'; });
        if (parsed.parse.title) canonical = parsed.parse.title;
      }
    }
    if (result && result.meanings.length) {
      result.word = canonical;
      return result;
    }
    // The parse endpoint gave us nothing: fall back to the lighter REST API.
    return fetchJson(ENDPOINTS.wiktionaryRest(word))
      .catch(() => null)
      .then((rest) => {
        if (!rest) return result;
        const groups = Array.isArray(rest) ? rest : Object.keys(rest).map((key) => rest[key]);
        const meanings = groups
          .filter(Array.isArray)
          .flat()
          .filter((entry) => (entry.language || 'English').toLowerCase() === 'english')
          .map((entry) => ({
            partOfSpeech: entry.partOfSpeech || 'Unspecified',
            key: posKeyFromId(entry.partOfSpeech) || 'unspecified',
            source: 'Wiktionary',
            definitions: (entry.definitions || [])
              .map((definition) => {
                const examples = unique(
                  (definition.parsedExamples || [])
                    .map((item) => stripHtml(item.example))
                    .filter(Boolean)
                );
                return {
                  definition: stripHtml(definition.definition),
                  example: examples[0] || '',
                  examples,
                  synonyms: [],
                  antonyms: []
                };
              })
              .filter((item) => item.definition)
          }))
          .filter((meaning) => meaning.definitions.length);
        if (meanings.length) {
          result = result || {
            pronunciation: { ipa: [], enpr: [], arpabet: [], audio: [], rhymes: [] },
            etymology: [],
            forms: [],
            hyphenation: ''
          };
          result.meanings = meanings;
          result.source = 'Wiktionary';
        }
        result.word = canonical;
        return result;
      });
  });
}

function fetchDatamuse(word) {
  return Promise.all([
    fetchJson(ENDPOINTS.datamuse(word), REQUEST_TIMEOUT_SHORT).catch(() => null),
    fetchJson(ENDPOINTS.datamuseRelated(word, 'rel_syn'), REQUEST_TIMEOUT_SHORT).catch(() => null),
    fetchJson(ENDPOINTS.datamuseRelated(word, 'rel_ant'), REQUEST_TIMEOUT_SHORT).catch(() => null)
  ]).then(([base, syn, ant]) => {
    const entry = Array.isArray(base) ? base[0] : null;
    if (!entry) return null;

    const tags = entry.tags || [];
    const frequencyTag = tags.find((tag) => /^n:/.test(tag));
    const arpabet = tags.map((tag) => (tag.startsWith('pron:') ? tag.slice(5).trim() : '')).filter(Boolean);
    const rhymes = tags.map((tag) => (tag.startsWith('r:') ? tag.slice(2).trim() : '')).filter(Boolean);
    const posCodes = tags.filter((tag) => DATAMUSE_POS[tag]);

    const byPos = new Map();
    (entry.defs || []).forEach((raw) => {
      const tab = raw.indexOf('\t');
      const code = tab === -1 ? '' : raw.slice(0, tab);
      const text = tab === -1 ? raw : raw.slice(tab + 1);
      const cleaned = text
        .replace(/^\*\s*/, '')
        .replace(/\s+/g, ' ')
        .replace(/^,\s*/, '')
        .trim();
      if (!cleaned) return;
      // Datamuse copies Wiktionary sense-group headings; they are not senses.
      if (/^(Terms (relating|concerning)|Usage|Senses?|Meaning)s?\b/i.test(cleaned)) return;
      const key = posKeyFromId(DATAMUSE_POS[code] || '') || code || 'unspecified';
      if (!byPos.has(key)) byPos.set(key, []);
      byPos.get(key).push(cleaned);
    });

    const meanings = [];
    (posCodes.length ? posCodes : Array.from(byPos.keys())).forEach((code) => {
      const key = posKeyFromId(DATAMUSE_POS[code] || code) || 'unspecified';
      const defs = byPos.get(key);
      if (!defs || !defs.length) return;
      meanings.push({
        partOfSpeech: titleCase(DATAMUSE_POS[code] || key),
        key,
        source: 'Datamuse',
        definitions: defs.map((text) => ({ definition: text, example: '', examples: [], synonyms: [], antonyms: [] }))
      });
    });

    return {
      source: 'Datamuse',
      meanings,
      pronunciation: { ipa: [], enpr: [], arpabet: unique(arpabet), audio: [], rhymes: unique(rhymes) },
      synonyms: unique((syn || []).map((item) => item.word)),
      antonyms: unique((ant || []).map((item) => item.word)),
      frequency: frequencyTag ? { rank: Number(frequencyTag.slice(2)), raw: frequencyTag } : null,
      score: entry.score
    };
  });
}

function lookupWord(rawWord) {
  const word = String(rawWord || '').trim();
  return Promise.all([fetchDictionaryApi(word), fetchWiktionary(word), fetchDatamuse(word)])
    .then(([dictionary, wiktionary, datamuse]) => {
      const sources = [];
      if (dictionary) sources.push('dictionaryapi.dev');
      if (wiktionary) sources.push('Wiktionary');
      if (datamuse) sources.push('Datamuse');

      if (!dictionary && !wiktionary && !datamuse) return null;

      // Order sources by how trustworthy their data is, then merge POS groups.
      const ordered = []
        .concat(dictionary ? dictionary.meanings : [])
        .concat(wiktionary ? wiktionary.meanings : [])
        .concat(datamuse ? datamuse.meanings : []);

      const meanings = [];
      const byKey = new Map();
      ordered.forEach((meaning) => {
        let target = byKey.get(meaning.key);
        if (!target) {
          target = {
            partOfSpeech: meaning.partOfSpeech,
            key: meaning.key,
            source: meaning.source,
            etymology: meaning.etymology || '',
            forms: [],
            definitions: []
          };
          byKey.set(meaning.key, target);
          meanings.push(target);
        }
        if (!target.etymology && meaning.etymology) target.etymology = meaning.etymology;
        target.forms = unique(target.forms.concat(meaning.forms || []));
        const seen = new Set(target.definitions.map((item) => item.definition.toLowerCase()));
        meaning.definitions.forEach((definition) => {
          const fingerprint = definition.definition.toLowerCase();
          if (seen.has(fingerprint)) {
            const existing = target.definitions.find((item) => item.definition.toLowerCase() === fingerprint);
            if (existing) {
              existing.synonyms = unique(existing.synonyms.concat(definition.synonyms || []));
              existing.antonyms = unique(existing.antonyms.concat(definition.antonyms || []));
              existing.examples = unique((existing.examples || []).concat(definition.examples || []));
              existing.example = existing.example || definition.example || '';
            }
            return;
          }
          seen.add(fingerprint);
          target.definitions.push(definition);
        });
      });

      const inlineSynonyms = unique(
        meanings.reduce((acc, meaning) => acc.concat(
          meaning.definitions.reduce((inner, definition) => inner.concat(definition.synonyms || []), [])
        ), [])
      );
      const inlineAntonyms = unique(
        meanings.reduce((acc, meaning) => acc.concat(
          meaning.definitions.reduce((inner, definition) => inner.concat(definition.antonyms || []), [])
        ), [])
      );

      const pronunciation = {
        ipa: unique([...(dictionary ? dictionary.pronunciation.ipa : []), ...(wiktionary ? wiktionary.pronunciation.ipa : [])]),
        enpr: unique(wiktionary ? wiktionary.pronunciation.enpr : []),
        arpabet: unique(datamuse ? datamuse.pronunciation.arpabet : []),
        rhymes: unique([
          ...(wiktionary ? wiktionary.pronunciation.rhymes : []),
          ...(datamuse ? datamuse.pronunciation.rhymes : [])
        ]),
        audio: dedupeAudio([
          ...(dictionary ? dictionary.pronunciation.audio : []),
          ...(wiktionary ? wiktionary.pronunciation.audio : [])
        ])
      };

      const dictionarySynonyms = dictionary ? dictionary.synonyms : [];
      const dictionaryAntonyms = dictionary ? dictionary.antonyms : [];
      const datamuseSynonyms = inlineSynonyms.length ? [] : unique(datamuse ? datamuse.synonyms : []);
      const datamuseAntonyms = inlineAntonyms.length ? [] : unique(datamuse ? datamuse.antonyms : []);

      return {
        word: (wiktionary && wiktionary.word) || word,
        sources,
        meanings,
        pronunciation,
        etymology: unique((wiktionary ? wiktionary.etymology : []).slice(0, 4)),
        forms: unique((wiktionary ? wiktionary.forms : []).slice(0, 12)),
        synonyms: unique([...inlineSynonyms, ...dictionarySynonyms, ...datamuseSynonyms]),
        antonyms: unique([...inlineAntonyms, ...dictionaryAntonyms, ...datamuseAntonyms]),
        frequency: datamuse ? datamuse.frequency : null
      };
    });
}

function dedupeAudio(list) {
  const seen = new Set();
  return list.filter((item) => {
    if (!item || !item.url) return false;
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 6);
}

/* -------------------------------------------------------------- rendering */

function badge(text, kind) {
  return `<span class="tag tag-${kind || 'default'}">${escapeHtml(text)}</span>`;
}

function renderAudio(audio) {
  if (!audio.length) return '';
  const items = audio.map((item, index) => `
    <button class="audio-btn" type="button" data-audio-index="${index}">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>
      <span>${escapeHtml(item.accent || item.label || 'Pronunciation')}</span>
    </button>`).join('');
  return `<div class="audio-row">${items}</div>`;
}

function renderDefinitions(meaning) {
  return meaning.definitions.map((definition, index) => {
    const examples = (definition.examples && definition.examples.length ? definition.examples : [definition.example])
      .filter(Boolean)
      .slice(0, 3)
      .map((example) => `<li class="example">${escapeHtml(example)}</li>`)
      .join('');
    const related = [];
    if (definition.synonyms && definition.synonyms.length) {
      related.push(`<span class="rel-label syn">syn</span>${definition.synonyms.slice(0, 8).map((w) => badge(w, 'syn')).join('')}`);
    }
    if (definition.antonyms && definition.antonyms.length) {
      related.push(`<span class="rel-label ant">ant</span>${definition.antonyms.slice(0, 8).map((w) => badge(w, 'ant')).join('')}`);
    }
    return `
      <li class="def-item">
        <div class="def-head">
          <span class="def-index">${index + 1}</span>
          <p class="def-text">${escapeHtml(definition.definition)}</p>
        </div>
        ${examples ? `<ul class="example-list">${examples}</ul>` : ''}
        ${related.length ? `<div class="rel-row">${related.join('')}</div>` : ''}
      </li>`;
  }).join('');
}

function renderMeaning(meaning) {
  const forms = (meaning.forms || [])
    .filter((form) => form && form.toLowerCase() !== (meaning.partOfSpeech || '').toLowerCase())
    .slice(0, 6);
  return `
    <section class="meaning">
      <div class="meaning-head">
        ${badge(meaning.partOfSpeech || 'Unspecified', 'pos')}
        <span class="meaning-source">${escapeHtml(meaning.source || '')}</span>
      </div>
      ${meaning.etymology ? `<p class="meaning-etym"><span class="etym-label">etym</span>${escapeHtml(meaning.etymology)}</p>` : ''}
      <ol class="def-list">${renderDefinitions(meaning)}</ol>
      ${forms.length ? `<div class="forms-row"><span class="rel-label">forms</span>${forms.map((f) => badge(f, 'form')).join('')}</div>` : ''}
    </section>`;
}

function renderWordList(title, words, kind) {
  if (!words || !words.length) return '';
  return `
    <div class="info-group">
      <p class="info-label">${escapeHtml(title)}</p>
      <div class="word-chips">${words.slice(0, 16).map((w) => badge(w, kind)).join('')}</div>
    </div>`;
}

function renderEntry(entry) {
  const { pronunciation: p } = entry;
  const ipaLine = p.ipa.length ? p.ipa.slice(0, 3).join('  ·  ') : '';
  const parts = [];
  if (ipaLine) parts.push(`<span class="ipa">${escapeHtml(ipaLine)}</span>`);
  if (p.enpr.length) parts.push(`<span class="enpr">${escapeHtml(p.enpr.slice(0, 2).join(', '))}</span>`);
  if (p.arpabet.length) parts.push(`<span class="arpabet">${escapeHtml(p.arpabet.slice(0, 2).join('  |  '))}</span>`);

  const meta = [];
  if (p.rhymes.length) meta.push(`<span class="meta-item"><span class="meta-key">rhymes</span> -${escapeHtml(p.rhymes.slice(0, 3).join(' -'))}-</span>`);
  if (entry.forms.length) meta.push(`<span class="meta-item"><span class="meta-key">forms</span> ${escapeHtml(entry.forms.slice(0, 4).join(', '))}</span>`);
  if (entry.frequency && entry.frequency.rank) {
    meta.push(`<span class="meta-item"><span class="meta-key">freq</span> rank ${escapeHtml(String(entry.frequency.rank))}</span>`);
  }

  return `
    <div class="entry">
      <div class="word-header">
        <div class="word-heading">
          <h2 class="word-title">${escapeHtml(entry.word)}</h2>
          ${parts.length ? `<p class="word-phonetics">${parts.join('<span class="sep">|</span>')}</p>` : ''}
        </div>
        ${renderAudio(p.audio)}
      </div>

      ${meta.length ? `<div class="meta-row">${meta.join('')}</div>` : ''}

      ${entry.meanings.map(renderMeaning).join('')}

      ${entry.etymology.length ? `
        <div class="info-group">
          <p class="info-label">Etymology</p>
          ${entry.etymology.map((text) => `<p class="etym-text">${escapeHtml(text)}</p>`).join('')}
        </div>` : ''}

      ${renderWordList('Synonyms', entry.synonyms, 'syn')}
      ${renderWordList('Antonyms', entry.antonyms, 'ant')}

      <div class="source-row">
        ${entry.sources.map((source) => badge(source, 'src')).join('')}
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- UI layer */

let currentAudio = null;
let currentIndex = -1;
let state = {};

function setAudioIndex(index) {
  currentIndex = index;
  if (!state || !state.entry) return;
  const entry = state.entry;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  const item = entry.pronunciation.audio[index];
  if (!item) return;
  currentAudio = new Audio(item.url);
  currentAudio.addEventListener('ended', () => {
    currentIndex = -1;
    paintAudioButtons();
  });
  const playPromise = currentAudio.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(() => {
      currentAudio = null;
      currentIndex = -1;
      paintAudioButtons();
      showAudioWarning();
    });
  }
  paintAudioButtons();
}

function showAudioWarning() {
  const row = document.querySelector('.audio-row');
  if (!row || row.parentElement.querySelector('.audio-warn')) return;
  const note = document.createElement('p');
  note.className = 'audio-warn';
  note.textContent = '> This audio stream could not be played. Tap the button again to retry.';
  row.parentElement.appendChild(note);
}

function paintAudioButtons() {
  const buttons = document.querySelectorAll('.audio-btn');
  buttons.forEach((button) => {
    const index = Number(button.dataset.audioIndex);
    const active = index === currentIndex && !!currentAudio;
    button.classList.toggle('playing', active);
    const label = button.querySelector('span');
    if (label && state.entry) {
      const item = state.entry.pronunciation.audio[index];
      if (item) label.textContent = (item.accent || item.label || 'Audio') + (active ? ' • playing' : '');
    }
  });
}

function showStatus(html) {
  const body = document.querySelector('.text-body');
  if (body) body.innerHTML = html;
}

function skeleton() {
  return `<div class="loading">
    <div class="skeleton-line w-40"></div>
    <div class="skeleton-line w-90"></div>
    <div class="skeleton-line w-70"></div>
    <div class="skeleton-line w-60"></div>
    <p class="loading-text">&gt; Querying lexicon nodes...</p>
  </div>`;
}

function readHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((w) => typeof w === 'string') : [];
  } catch (err) {
    return [];
  }
}

function pushHistory(word) {
  try {
    const next = unique([word, ...readHistory()]).slice(0, HISTORY_LIMIT);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    renderHistory();
  } catch (err) {
    /* storage disabled - ignore */
  }
}

function renderHistory() {
  const container = document.querySelector('.history-row');
  if (!container) return;
  const words = readHistory();
  container.innerHTML = words.length
    ? words.map((word) => `<button class="chip chip-history" type="button" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join('')
    : '<span class="history-empty">&gt; no recent queries</span>';
}

function search(word) {
  const input = document.querySelector('.input');
  const value = String(word == null ? (input ? input.value : '') : word).trim();
  if (!value) {
    showStatus('<div class="idle-state"><p>&gt; Please enter a word to search.</p></div>');
    return;
  }
  if (input) input.value = value;
  showStatus(skeleton());

  lookupWord(value)
    .then((entry) => {
      if (!entry) {
        showStatus(`<div class="error-state"><p>&gt; No lexicon entry found for "${escapeHtml(value)}".</p><p class="hint">All dictionary sources were unreachable or had nothing for this term.</p></div>`);
        return;
      }
      if (!entry.meanings.length) {
        showStatus(`<div class="error-state"><p>&gt; No definitions found for "${escapeHtml(value)}".</p></div>`);
        return;
      }
      state = { entry };
      currentAudio = null;
      currentIndex = -1;
      showStatus(renderEntry(entry));
      paintAudioButtons();
      pushHistory(value);
    })
    .catch((error) => {
      console.error('Lookup failed:', error);
      showStatus('<div class="error-state"><p>&gt; Connection error while querying dictionary services.</p></div>');
    });
}

function randomWord() {
  showStatus('<div class="idle-state"><p>&gt; Fetching a random word...</p></div>');
  fetchJson('https://api.datamuse.com/words?random&max=1', REQUEST_TIMEOUT_SHORT)
    .then((data) => {
      const word = Array.isArray(data) && data[0] && data[0].word;
      if (!word) throw new Error('no random word');
      search(word);
    })
    .catch(() => showStatus('<div class="error-state"><p>&gt; Could not fetch a random word. Try again.</p></div>'));
}

function wireEvents() {
  const input = document.querySelector('.input');
  const button = document.querySelector('.search-btn');
  if (button) button.addEventListener('click', () => search());
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        search();
      }
    });
  }
  const body = document.querySelector('.text-body');
  if (body) {
    body.addEventListener('click', (event) => {
      const audio = event.target.closest('.audio-btn');
      if (audio) {
        const index = Number(audio.dataset.audioIndex);
        if (index === currentIndex && currentAudio) {
          currentAudio.pause();
          currentAudio = null;
          currentIndex = -1;
          paintAudioButtons();
        } else {
          setAudioIndex(index);
        }
        return;
      }
      const word = event.target.closest('[data-word]');
      if (word) search(word.dataset.word);
    });
  }
  const randomBtn = document.querySelector('.random-btn');
  if (randomBtn) randomBtn.addEventListener('click', randomWord);
  const history = document.querySelector('.history-row');
  if (history) {
    history.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip-history');
      if (chip) search(chip.dataset.word);
    });
  }
  if (input) input.focus();
  renderHistory();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireEvents);
  } else {
    wireEvents();
  }
}
