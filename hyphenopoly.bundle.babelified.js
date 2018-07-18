"use strict";

(function () {
  function e(t, n, r) {
    function s(o, u) {
      if (!n[o]) {
        if (!t[o]) {
          var a = typeof require == "function" && require; if (!u && a) return a(o, !0); if (i) return i(o, !0); var f = new Error("Cannot find module '" + o + "'"); throw f.code = "MODULE_NOT_FOUND", f;
        } var l = n[o] = { exports: {} }; t[o][0].call(l.exports, function (e) {
          var n = t[o][1][e]; return s(n ? n : e);
        }, l, l.exports, e, t, n, r);
      } return n[o].exports;
    } var i = typeof require == "function" && require; for (var o = 0; o < r.length; o++) {
      s(r[o]);
    } return s;
  } return e;
})()({
  1: [function (require, module, exports) {
    /*
     * @license Hyphenopoly.module.js 2.2.0-devel - hyphenation for node
     *  ©2018  Mathias Nater, Zürich (mathiasnater at gmail dot com)
     *  https://github.com/mnater/Hyphenopoly
     *
     *  Released under the MIT license
     *  http://mnater.github.io/Hyphenopoly/LICENSE
     */

    /* eslint-env node */
    /* eslint no-console: 0 */
    "use strict";

    var decode = function makeDecoder() {
      var decoder = function decoder(ui16) {
        var i = 0;
        var str = "";
        while (i < ui16.length) {
          str += String.fromCharCode(ui16[i]);
          i += 1;
        }
        return str;
      };
      return decoder;
    }();

    var SOFTHYPHEN = String.fromCharCode(173);

    /**
     * Create Object without standard Object-prototype
     * @returns {Object} empty object
     */
    function empty() {
      return Object.create(null);
    }

    /**
     * Set value and properties of object member
     * Argument <props> is a bit pattern:
     * 1. bit: configurable
     * 2. bit: enumerable
     * 3. bit writable
     * e.g. 011(2) = 3(10) => configurable: f, enumerable: t, writable: t
     * or   010(2) = 2(10) => configurable: f, enumerable: t, writable: f
     * @param {any} val The value
     * @param {number} props bitfield
     * @returns {Object} Property object
     */
    function setProp(val, props) {
      /* eslint-disable no-bitwise, sort-keys */
      return {
        "configurable": (props & 4) > 0,
        "enumerable": (props & 2) > 0,
        "writable": (props & 1) > 0,
        "value": val
      };
      /* eslint-enable no-bitwise, sort-keys */
    }

    var H = empty();
    H.binaries = empty();

    /**
     * Read a wasm file
     * @returns {undefined}
     */
    function loadWasm() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', H.c.paths.maindir + "hyphenEngine.wasm");
      xhr.responseType = "arraybuffer";
      xhr.onload = function () {
        if (xhr.status === 200) {
          H.binaries.hyphenEngine = new Uint8Array(xhr.response).buffer;
          H.events.dispatch("engineLoaded");
        } else {
          H.events.dispatch("error", {
            "key": "hyphenEngine",
            "msg": H.c.paths.maindir + "hyphenEngine.wasm not found.\n" + xhr.status
          });
        }
      };
      xhr.send();
    }

    /**
     * Read a hpb file
     * @param {string} lang - The language
     * @returns {undefined}
     */
    function loadHpb(lang) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', "" + H.c.paths.patterndir + lang + ".hpb");
      xhr.responseType = "arraybuffer";
      xhr.onload = function () {
        if (xhr.status === 200) {
          H.binaries[lang] = new Uint8Array(xhr.response).buffer;
          H.events.dispatch("hpbLoaded", { "msg": lang });
        } else {
          H.events.dispatch("error", {
            "key": lang,
            "msg": "" + H.c.paths.patterndir + lang + ".hpb not found.\n" + xhr.status
          });
        }
      };
      xhr.send();
    }

    /**
     * Calculate heap size for wasm
     * wasm page size: 65536 = 64 Ki
     * @param {number} targetSize The targetet Size
     * @returns {number} The necessary heap size
     */
    function calculateHeapSize(targetSize) {
      return Math.ceil(targetSize / 65536) * 65536;
    }

    /**
     * Calculate Base Data
     *
     * Build Heap (the heap object's byteLength must be
     * either 2^n for n in [12, 24)
     * or 2^24 · n for n ≥ 1;)
     *
     * MEMORY LAYOUT:
     *
     * -------------------- <- Offset 0
     * |   translateMap   |
     * |        keys:     |
     * |256 chars * 2Bytes|
     * |         +        |
     * |      values:     |
     * |256 chars * 1Byte |
     * -------------------- <- 768 Bytes
     * |     alphabet     |
     * |256 chars * 2Bytes|
     * -------------------- <- valueStoreOffset = 1280
     * |    valueStore    |
     * |      1 Byte      |
     * |* valueStoreLength|
     * --------------------
     * | align to 4Bytes  |
     * -------------------- <- patternTrieOffset
     * |    patternTrie   |
     * |     4 Bytes      |
     * |*patternTrieLength|
     * -------------------- <- wordOffset
     * |    wordStore     |
     * |    Uint16[64]    | 128 bytes
     * -------------------- <- translatedWordOffset
     * | transl.WordStore |
     * |    Uint16[64]     | 128 bytes
     * -------------------- <- hyphenPointsOffset
     * |   hyphenPoints   |
     * |    Uint8[64]     | 64 bytes
     * -------------------- <- hyphenatedWordOffset
     * |  hyphenatedWord  |
     * |   Uint16[128]    | 256 Bytes
     * -------------------- <- hpbOffset           -
     * |     HEADER       |                        |
     * |    6*4 Bytes     |                        |
     * |    24 Bytes      |                        |
     * --------------------                        |
     * |    PATTERN LIC   |                        |
     * |  variable Length |                        |
     * --------------------                        |
     * | align to 4Bytes  |                        } this is the .hpb-file
     * -------------------- <- hpbTranslateOffset  |
     * |    TRANSLATE     |                        |
     * | 2 + [0] * 2Bytes |                        |
     * -------------------- <- hpbPatternsOffset   |
     * |     PATTERNS     |                        |
     * |  patternsLength  |                        |
     * -------------------- <- heapEnd             -
     * | align to 4Bytes  |
     * -------------------- <- heapSize
     * @param {Object} hpbBuf FileBuffer from .hpb-file
     * @returns {Object} baseData-object
     */
    function calculateBaseData(hpbBuf) {
      var hpbMetaData = new Uint32Array(hpbBuf).subarray(0, 8);
      var valueStoreLength = hpbMetaData[7];
      var valueStoreOffset = 1280;
      var patternTrieOffset = valueStoreOffset + valueStoreLength + (4 - (valueStoreOffset + valueStoreLength) % 4);
      var wordOffset = patternTrieOffset + hpbMetaData[6] * 4;
      return {
        "heapSize": Math.max(calculateHeapSize(wordOffset + 576 + hpbMetaData[2] + hpbMetaData[3]), 32 * 1024 * 64),
        "hpbOffset": wordOffset + 576,
        "hpbPatternsOffset": wordOffset + 576 + hpbMetaData[2],
        "hpbTranslateOffset": wordOffset + 576 + hpbMetaData[1],
        "hyphenatedWordOffset": wordOffset + 320,
        "hyphenPointsOffset": wordOffset + 256,
        "leftmin": hpbMetaData[4],
        "patternsLength": hpbMetaData[3],
        "patternTrieOffset": patternTrieOffset,
        "rightmin": hpbMetaData[5],
        "translatedWordOffset": wordOffset + 128,
        "valueStoreOffset": valueStoreOffset,
        "wordOffset": wordOffset
      };
    }

    /**
     * Convert exceptions to object
     * @param {string} exc comma separated list of exceptions
     * @returns {Object} Map of exceptions
     */
    function convertExceptions(exc) {
      var words = exc.split(", ");
      var r = empty();
      var l = words.length;
      var i = 0;
      var key = null;
      while (i < l) {
        key = words[i].replace(/-/g, "");
        if (!r[key]) {
          r[key] = words[i];
        }
        i += 1;
      }
      return r;
    }

    /**
     * Setup lo
     * @param {string} lang The language
     * @param {function} hyphenateFunction The hyphenateFunction
     * @param {string} alphabet List of used characters
     * @param {number} leftmin leftmin
     * @param {number} rightmin rightmin
     * @returns {undefined}
     */
    function prepareLanguagesObj(lang, hyphenateFunction, alphabet, leftmin, rightmin) {
      alphabet = alphabet.replace(/-/g, "");
      if (!H.languages) {
        H.languages = empty();
      }
      if (!H.languages[lang]) {
        H.languages[lang] = empty();
      }
      var lo = H.languages[lang];
      if (!lo.engineReady) {
        lo.cache = empty();
        if (H.c.exceptions.global) {
          if (H.c.exceptions[lang]) {
            H.c.exceptions[lang] += ", " + H.c.exceptions.global;
          } else {
            H.c.exceptions[lang] = H.c.exceptions.global;
          }
        }
        if (H.c.exceptions[lang]) {
          lo.exceptions = convertExceptions(H.c.exceptions[lang]);
          delete H.c.exceptions[lang];
        } else {
          lo.exceptions = empty();
        }
        lo.genRegExp = new RegExp("[\\w" + alphabet + String.fromCharCode(8204) + "-]{" + H.c.minWordLength + ",}", "gi");
        lo.leftmin = leftmin;
        lo.rightmin = rightmin;
        lo.hyphenateFunction = hyphenateFunction;
        lo.engineReady = true;
      }
      H.events.dispatch("engineReady", { "msg": lang });
    }

    /**
     * Setup env for hyphenateFunction
     * @param {Object} baseData baseData
     * @param {function} hyphenateFunc hyphenateFunction
     * @returns {function} hyphenateFunction with closured environment
     */
    function encloseHyphenateFunction(baseData, hyphenateFunc) {
      /* eslint-disable no-bitwise */
      var heapBuffer = baseData.wasmMemory.buffer;
      var wordOffset = baseData.wordOffset;
      var hyphenatedWordOffset = baseData.hyphenatedWordOffset;
      var wordStore = new Uint16Array(heapBuffer).subarray(wordOffset >> 1, (wordOffset >> 1) + 64);
      var defLeftmin = baseData.leftmin;
      var defRightmin = baseData.rightmin;
      var hyphenatedWordStore = new Uint16Array(heapBuffer).subarray(hyphenatedWordOffset >> 1, (hyphenatedWordOffset >> 1) + 64);
      /* eslint-enable no-bitwise */
      return function hyphenate(word, hyphenchar, leftmin, rightmin) {
        var i = 0;
        var wordLength = word.length;
        leftmin = leftmin || defLeftmin;
        rightmin = rightmin || defRightmin;
        wordStore[0] = wordLength + 2;
        wordStore[1] = 95;
        while (i < wordLength) {
          wordStore[i + 2] = word.charCodeAt(i);
          i += 1;
        }
        wordStore[i + 2] = 95;

        if (hyphenateFunc(leftmin, rightmin) === 1) {
          i = 1;
          word = "";
          while (i < hyphenatedWordStore[0] + 1) {
            word += String.fromCharCode(hyphenatedWordStore[i]);
            i += 1;
          }
          if (hyphenchar !== "\xAD") {
            word = word.replace(/\u00AD/g, hyphenchar);
          }
        }
        return word;
      };
    }

    /**
     * Instantiate Wasm Engine
     * @param {string} lang The language
     * @returns {undefined}
     */
    function instantiateWasmEngine(lang) {
      var baseData = calculateBaseData(H.binaries[lang]);
      var wasmMemory = new WebAssembly.Memory({
        "initial": baseData.heapSize / 65536,
        "maximum": 256
      });
      var ui32wasmMemory = new Uint32Array(wasmMemory.buffer);
      ui32wasmMemory.set(new Uint32Array(H.binaries[lang]),
        // eslint-disable-next-line no-bitwise
        baseData.hpbOffset >> 2);
      baseData.wasmMemory = wasmMemory;
      WebAssembly.instantiate(H.binaries.hyphenEngine, {
        "env": {
          "memory": baseData.wasmMemory,
          "memoryBase": 0
        },
        "ext": {
          "hpbPatternsOffset": baseData.hpbPatternsOffset,
          "hpbTranslateOffset": baseData.hpbTranslateOffset,
          "hyphenatedWordOffset": baseData.hyphenatedWordOffset,
          "hyphenPointsOffset": baseData.hyphenPointsOffset,
          "patternsLength": baseData.patternsLength,
          "patternTrieOffset": baseData.patternTrieOffset,
          "translatedWordOffset": baseData.translatedWordOffset,
          "valueStoreOffset": baseData.valueStoreOffset,
          "wordOffset": baseData.wordOffset
        }
      }).then(function runWasm(result) {
        result.instance.exports.convert();
        prepareLanguagesObj(lang, encloseHyphenateFunction(baseData, result.instance.exports.hyphenate), decode(new Uint16Array(wasmMemory.buffer).subarray(384, 640)), baseData.leftmin, baseData.rightmin);
      });
    }

    var engineInstantiator = null;
    var hpb = [];

    /**
     * Instantiate hyphenEngines for languages
     * @param {string} lang The language
     * @returns {undefined}
     */
    function prepare(lang) {
      if (lang === "*") {
        engineInstantiator = instantiateWasmEngine;

        /*
         * Deleted:
         * hpb.forEach(function eachHbp(hpbLang) {
         *    engineInstantiator(hpbLang);
         *});
         */
      } else if (engineInstantiator) {
        engineInstantiator(lang);
      } else {
        hpb.push(lang);
      }
    }

    var wordHyphenatorPool = empty();

    /**
     * Factory for hyphenatorFunctions for a specific language and class
     * @param {Object} lo Language-Object
     * @param {string} lang The language
     * @returns {function} The hyphenate function
     */
    function createWordHyphenator(lo, lang) {
      lo.cache = empty();

      /**
       * HyphenateFunction for compound words
       * @param {string} word The word
       * @returns {string} The hyphenated compound word
       */
      function hyphenateCompound(word) {
        var zeroWidthSpace = String.fromCharCode(8203);
        var parts = null;
        var i = 0;
        var wordHyphenator = null;
        var hw = word;
        switch (H.c.compound) {
          case "auto":
            parts = word.split("-");
            wordHyphenator = createWordHyphenator(lo, lang);
            while (i < parts.length) {
              if (parts[i].length >= H.c.minWordLength) {
                parts[i] = wordHyphenator(parts[i]);
              }
              i += 1;
            }
            hw = parts.join("-");
            break;
          case "all":
            parts = word.split("-");
            wordHyphenator = createWordHyphenator(lo, lang);
            while (i < parts.length) {
              if (parts[i].length >= H.c.minWordLength) {
                parts[i] = wordHyphenator(parts[i]);
              }
              i += 1;
            }
            hw = parts.join("-" + zeroWidthSpace);
            break;
          default:
            hw = word.replace("-", "-" + zeroWidthSpace);
        }
        return hw;
      }

      /**
       * HyphenateFunction for words (compound or not)
       * @param {string} word The word
       * @returns {string} The hyphenated word
       */
      function hyphenator(word) {
        var hw = lo.cache[word];
        if (!hw) {
          if (lo.exceptions[word]) {
            hw = lo.exceptions[word].replace(/-/g, H.c.hyphen);
          } else if (word.indexOf("-") === -1) {
            hw = lo.hyphenateFunction(word, H.c.hyphen, H.c.leftmin, H.c.rightmin);
          } else {
            hw = hyphenateCompound(word);
          }
          lo.cache[word] = hw;
        }
        return hw;
      }
      wordHyphenatorPool[lang] = hyphenator;
      return hyphenator;
    }

    var orphanController = function createOrphanController() {
      /**
       * Function template
       * @param {string} ignore unused result of replace
       * @param {string} leadingWhiteSpace The leading whiteSpace
       * @param {string} lastWord The last word
       * @param {string} trailingWhiteSpace The trailing whiteSpace
       * @returns {string} Treated end of text
       */
      function controlOrphans(ignore, leadingWhiteSpace, lastWord, trailingWhiteSpace) {
        var h = H.c.hyphen;
        if (".\\+*?[^]$(){}=!<>|:-".indexOf(H.c.hyphen) !== -1) {
          h = "\\" + H.c.hyphen;
        }
        if (H.c.orphanControl === 3 && leadingWhiteSpace === " ") {
          leadingWhiteSpace = String.fromCharCode(160);
        }
        return leadingWhiteSpace + lastWord.replace(new RegExp(h, "g"), "") + trailingWhiteSpace;
      }
      return controlOrphans;
    }();

    /**
     * Encloses hyphenateTextFunction
     * @param {string} lang - The language
     * @return {function} The hyphenateText-function
     */
    function createTextHyphenator(lang) {
      var lo = H.languages[lang];
      var wordHyphenator = wordHyphenatorPool[lang] ? wordHyphenatorPool[lang] : createWordHyphenator(lo, lang);

      /**
       * Hyphenate text
       * @param {string} text The text
       * @param {string} lang The language of the text
       * @returns {string} Hyphenated text
       */
      return function hyphenateText(text) {
        if (H.c.normalize) {
          text = text.normalize("NFC");
        }
        var tn = text.replace(lo.genRegExp, wordHyphenator);
        if (H.c.orphanControl !== 1) {
          tn = tn.replace(/(\u0020*)(\S+)(\s*)$/, orphanController);
        }
        return tn;
      };
    }

    H.config = function config(userConfig) {
      var defaults = Object.create(null, {
        "compound": setProp("hyphen", 2),
        "exceptions": setProp(empty(), 2),
        "hyphen": setProp(SOFTHYPHEN, 2),
        "leftmin": setProp(0, 2),
        "minWordLength": setProp(6, 2),
        "normalize": setProp(false, 2),
        "orphanControl": setProp(1, 2),
        "paths": setProp(Object.create(null, {
          "maindir": setProp(window.sPathToHyphenopoly + "/", 2),
          "patterndir": setProp(window.sPathToHyphenopoly + "/patterns/", 2)
        }), 2),
        "require": setProp([], 2),
        "rightmin": setProp(0, 2)
      });
      var settings = Object.create(defaults);
      Object.keys(userConfig).forEach(function each(key) {
        Object.defineProperty(settings, key, setProp(userConfig[key], 3));
      });
      H.c = settings;
      if (H.c.handleEvent) {
        Object.keys(H.c.handleEvent).forEach(function add(name) {
          H.events.addListener(name, H.c.handleEvent[name], true);
        });
      }
      loadWasm();
      var result = new Map();
      H.c.require.forEach(function each(lang) {
        loadHpb(lang);
        var prom = new Promise(function pro(resolve, reject) {
          H.events.addListener("engineReady", function handler(e) {
            if (e.msg === lang) {
              resolve(createTextHyphenator(lang));
            }
          });
          H.events.addListener("error", function handler(e) {
            e.preventDefault();
            if (e.key === lang || e.key === "hyphenEngine") {
              reject(e.msg);
            }
          });
        });
        result.set(lang, prom);
      });
      return result.size === 1 ? result.get(H.c.require[0]) : result;
    };

    (function setupEvents() {
      // Events known to the system
      var definedEvents = empty();

      /**
       * Create Event Object
       * @param {string} name The Name of the event
       * @param {function|null} defFunc The default method of the event
       * @param {boolean} cancellable Is the default cancellable
       * @returns {undefined}
       */
      function define(name, defFunc, cancellable) {
        definedEvents[name] = {
          "cancellable": cancellable,
          "default": defFunc,
          "register": []
        };
      }

      define("error", function def(e) {
        console.error(e.msg);
      }, true);

      define("engineLoaded", function def() {
        prepare("*");
      }, false);

      define("hpbLoaded", function def(e) {
        prepare(e.msg);
      }, false);

      define("engineReady", null, false);

      /**
       * Dispatch error <name> with arguments <data>
       * @param {string} name The name of the event
       * @param {Object|undefined} data Data of the event
       * @returns {undefined}
       */
      function dispatch(name, data) {
        if (!data) {
          data = empty();
        }
        data.defaultPrevented = false;
        data.preventDefault = function preventDefault() {
          if (definedEvents[name].cancellable) {
            data.defaultPrevented = true;
          }
        };
        definedEvents[name].register.forEach(function call(currentHandler) {
          currentHandler(data);
        });
        if (!data.defaultPrevented && definedEvents[name].default) {
          definedEvents[name].default(data);
        }
      }

      /**
       * Add EventListender <handler> to event <name>
       * @param {string} name The name of the event
       * @param {function} handler Function to register
       * @returns {undefined}
       */
      function addListener(name, handler) {
        if (definedEvents[name]) {
          definedEvents[name].register.push(handler);
        } else {
          H.events.dispatch("error", { "msg": "unknown Event \"" + name + "\" discarded" });
        }
      }

      H.events = empty();
      H.events.dispatch = dispatch;
      H.events.define = define;
      H.events.addListener = addListener;
    })();

    module.exports = H;
  }, {}], 2: [function (require, module, exports) {
    var hyphenopoly = require('./hyphenopoly.browser');

    window.hyphenopoly = hyphenopoly;
  }, { "./hyphenopoly.browser": 1 }]
}, {}, [2]);