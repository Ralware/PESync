/* ============================================================
 * PES Timetable — application logic (vanilla JS, no dependencies)
 *
 * Sections:
 *   1. Constants (storage keys)
 *   2. Subject definitions (default dataset + dynamic imports)
 *   3. Timetable data (original + working copy)
 *   4. State
 *   5. DOM references
 *   6. Utilities
 *   7. Countdown (load / save / render)
 *   8. Clock and date
 *   9. Timetable + subject storage (load / save / reset)
 *   10. Timetable rendering (single source of truth)
 *   11. Subject editor modal
 *   12. Countdown editor modal
 *   13. Shared modal helpers (focus return, Escape, backdrop)
 *   14. Event binding
 *   15. Initialization
 *   16. Screenshot import: backend AI analysis (Gemini via server)
 *   17. Screenshot import: review model helpers
 *   18. Screenshot import: state + DOM
 *   19. Screenshot import: analyze + review + import
 *
 * Data model:
 *   SUBJECT DATA (subjectDefinitions): id -> { code, shortCode, name,
 *     faculty, color }. The built-in defaults describe the default
 *     timetable only. Imported timetables create NEW entries
 *     dynamically — the screenshot is the source of truth and is
 *     never mapped onto the default subjects.
 *   TIMETABLE PLACEMENT (timetable): day -> [subjectId | null x7].
 *     One subject definition may appear in many cells.
 * ============================================================ */
(function () {
  "use strict";

  /* ---------- 1. Constants ---------- */
  var COUNTDOWN_STORAGE_KEY = "pes-timetable-countdown";
  var TIMETABLE_STORAGE_KEY = "pes-timetable-data";
  var SUBJECTS_STORAGE_KEY = "pes-timetable-subjects-custom";
  var METADATA_STORAGE_KEY = "pes-timetable-metadata";
  var DATE_REFRESH_MS = 30 * 1000;

  var defaultMetadata = {
    batch: "",
    className: "",
    department: "",
    section: "",
    room: "",
  };
  var timetableMetadata = cloneMetadata(defaultMetadata);

  /* ---------- 2. Subject definitions ---------- */
  /* DEFAULT dataset: the built-in timetable shown on first load.
   * It must NEVER constrain screenshot imports. */
  var defaultSubjectDefinitions = {
    python: {
      code: "UE26CS151A",
      shortCode: "CS151A",
      name: "Python for Computational Problem Solving",
      faculty: "F: Anil Kumar S",
      color: "var(--c-python)",
    },
    pythonLab: {
      code: "UE26CS151A (LAB)",
      shortCode: "CS151A (LAB)",
      name: "Python for CPS Integrated with Lab",
      faculty: "F: Anil Kumar S",
      color: "var(--c-python)",
    },
    math: {
      code: "UE26MA141A",
      shortCode: "MA141A",
      name: "Engineering Mathematics – I",
      faculty: "F: Ms Kavyashree",
      color: "var(--c-math)",
    },
    physics: {
      code: "UE26PH151A",
      shortCode: "PH151A",
      name: "Engineering Physics",
      faculty: "F: Shruti S Devangamath",
      color: "var(--c-physics)",
    },
    physicsLab: {
      code: "UE26PH151A (LAB)",
      shortCode: "PH151A (LAB)",
      name: "Engineering Physics Integrated with Lab",
      faculty: "F: Dr Reena I",
      color: "var(--c-physics)",
    },
    mech: {
      code: "UE26ME141A",
      shortCode: "ME141A",
      name: "Mechanical Engineering Sciences",
      faculty: "F: Srinivasa Prasad K S",
      color: "var(--c-mech)",
    },
    elec: {
      code: "UE26EE141A",
      shortCode: "EE141A",
      name: "Elements of Electrical Engineering",
      faculty: "F: Mrs Jyothi T.N",
      color: "var(--c-elec)",
    },
    env: {
      code: "UE26EV121A",
      shortCode: "EV121A",
      name: "Environmental Studies and Life Sciences",
      faculty: "F: Jhinuk Chatterjee",
      color: "var(--c-env)",
    },
  };

  /* Working definitions: defaults + dynamically imported subjects. */
  var subjectDefinitions = cloneSubjects(defaultSubjectDefinitions);

  /* Accent palette for dynamically created subjects (cycles). */
  var IMPORT_COLOR_PALETTE = [
    "var(--c-python)",
    "var(--c-math)",
    "var(--c-physics)",
    "var(--c-mech)",
    "var(--c-elec)",
    "var(--c-env)",
    "#c084fc",
    "#fb7185",
    "#34d399",
    "#fbbf24",
    "#60a5fa",
    "#f472b6",
  ];

  /* ---------- 3. Timetable data ---------- */
  /* Class-period labels for the editor subtitle. Breaks are fixed columns. */
  var timeSlots = [
    "08:00 - 09:00 AM",
    "09:00 - 10:00 AM",
    "10:30 - 11:30 AM",
    "11:30 - 12:30 PM",
    "01:15 - 02:15 PM",
    "02:15 - 03:15 PM",
    "03:15 - 04:00 PM",
  ];

  var dayOrder = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  var dayAbbr = {
    Monday: "Mon",
    Tuesday: "Tue",
    Wednesday: "Wed",
    Thursday: "Thu",
    Friday: "Fri",
    Saturday: "Sat",
  };

  /* Break columns sit after these class-slot indexes (Day | 2 slots | Break | 2 slots | Break | 3 slots). */
  var BREAK_AFTER_SLOTS = [1, 3];

  /* The active timetable intentionally starts empty. Built-in subject
   * definitions remain available in the manual editor, but are never placed
   * automatically. */
  function createEmptyTimetable() {
    var empty = {};
    dayOrder.forEach(function (day) {
      empty[day] = [null, null, null, null, null, null, null];
    });
    return empty;
  }

  /* ---------- 4. State ---------- */
  var timetable = createEmptyTimetable();
  var countdownTarget = { title: "Countdown", date: null };
  var editingDay = null;
  var editingSlot = -1;
  var countdownTriggerEl = null;
  var metadataTriggerEl = null;
  var subjectTriggerEl = null;

  /* ---------- 5. DOM references ---------- */
  var countdownCardEl = document.getElementById("countdown-card");
  var countdownTitleEl = document.getElementById("countdown-title");
  var countdownValueEl = document.getElementById("countdown-value");
  var liveCardEl = document.getElementById("live-card");
  var liveLabelEl = document.getElementById("live-label");
  var liveValueEl = document.getElementById("live-value");
  var liveHintEl = document.getElementById("live-hint");
  var timeEl = document.getElementById("current-time");
  var dateEl = document.getElementById("current-date");
  var timetableEl = document.getElementById("timetable");
  var resetBtn = document.getElementById("reset-timetable");
  var metadataTrigger = document.getElementById("metadata-trigger");
  var metadataValues = {
    batch: document.getElementById("metadata-batch"),
    className: document.getElementById("metadata-class"),
    department: document.getElementById("metadata-department"),
    section: document.getElementById("metadata-section"),
    room: document.getElementById("metadata-room"),
  };

  var countdownModalEl = document.getElementById("countdown-modal");
  var countdownNameInput = document.getElementById("countdown-name");
  var countdownDateInput = document.getElementById("countdown-date");
  var countdownTimeInput = document.getElementById("countdown-time");
  var countdownSaveBtn = document.getElementById("countdown-save");
  var countdownClearBtn = document.getElementById("countdown-clear");
  var countdownCancelBtn = document.getElementById("countdown-cancel");

  var metadataModalEl = document.getElementById("metadata-modal");
  var metadataModalInputs = {
    batch: document.getElementById("metadata-modal-batch"),
    className: document.getElementById("metadata-modal-class"),
    department: document.getElementById("metadata-modal-department"),
    section: document.getElementById("metadata-modal-section"),
    room: document.getElementById("metadata-modal-room"),
  };
  var metadataSaveBtn = document.getElementById("metadata-save");
  var metadataCancelBtn = document.getElementById("metadata-cancel");

  var subjectModalEl = document.getElementById("subject-modal");
  var subjectTitleEl = document.getElementById("subject-modal-title");
  var subjectSubtitleEl = document.getElementById("subject-modal-subtitle");
  var subjectSelect = document.getElementById("subject-select");
  var subjectSaveBtn = document.getElementById("subject-save");
  var subjectRemoveBtn = document.getElementById("subject-remove");
  var subjectCancelBtn = document.getElementById("subject-cancel");

  /* ---------- 6. Utilities ---------- */
  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function cloneTimetable(source) {
    return JSON.parse(JSON.stringify(source));
  }

  function cloneSubjects(source) {
    return JSON.parse(JSON.stringify(source));
  }

  function cloneMetadata(source) {
    return JSON.parse(JSON.stringify(source));
  }

  function isValidSubjectId(id) {
    return (
      typeof id === "string" &&
      Object.prototype.hasOwnProperty.call(subjectDefinitions, id)
    );
  }

  function readStorage(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null; /* corrupted storage or unavailable: fall back to defaults */
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable */
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* storage unavailable: nothing to do */
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s);
  }

  /* Format only all-caps human-readable text at render time. Stored values
   * remain the model/user's original values, while course codes and common
   * academic acronyms keep their intentional capitalization. */
  function formatDisplayText(value) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!text || text !== text.toUpperCase() || text === text.toLowerCase()) return text;
    if (/^[A-Z]+\d+[A-Z0-9-]*(?:\s*\(LAB\))?$/i.test(text)) return text;

    var preserved = {
      AI: true, AIML: true, CSE: true, ECE: true, EEE: true, ISE: true,
      IT: true, LAB: true, LECTURE: false, I: true, II: true, III: true,
      IV: true, V: true, VI: true, VII: true, VIII: true, IX: true, X: true,
    };
    var minor = { a: true, an: true, and: true, as: true, at: true, by: true,
      for: true, from: true, in: true, of: true, on: true, or: true, the: true,
      to: true, with: true };
    var words = text.match(/[A-Z0-9]+(?:\([A-Z0-9]+\))?/g) || [];
    var wordIndex = 0;

    return text.replace(/[A-Z0-9]+(?:\([A-Z0-9]+\))?/g, function (token) {
      var index = wordIndex++;
      if (/\d/.test(token) || /^[A-Z]{2,8}\([A-Z0-9]{2,10}\)$/.test(token)) return token;
      if (Object.prototype.hasOwnProperty.call(preserved, token) && preserved[token]) return token;
      var lower = token.toLowerCase();
      if (minor[lower] && index !== 0 && index !== words.length - 1) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    });
  }

  /* ---------- 7. Countdown ---------- */
  function loadCountdown() {
    var saved = readStorage(COUNTDOWN_STORAGE_KEY);
    if (saved && saved.date) {
      var d = new Date(saved.date);
      if (!isNaN(d.getTime())) {
        countdownTarget.title =
          typeof saved.title === "string" && saved.title.trim() !== ""
            ? saved.title
            : "Countdown";
        countdownTarget.date = d.getTime();
      }
    }
  }

  function saveCountdown() {
    try {
      if (countdownTarget.date == null) {
        localStorage.removeItem(COUNTDOWN_STORAGE_KEY);
      } else {
        localStorage.setItem(
          COUNTDOWN_STORAGE_KEY,
          JSON.stringify({
            title: countdownTarget.title,
            date: new Date(countdownTarget.date).toISOString(),
          }),
        );
      }
    } catch (e) {
      /* storage unavailable */
    }
  }

  function updateCountdown() {
    countdownTitleEl.textContent = (
      countdownTarget.title || "Countdown"
    ).toUpperCase();

    if (countdownTarget.date == null) {
      countdownValueEl.textContent = "Not Set";
      return;
    }

    var diff = countdownTarget.date - Date.now();
    if (diff <= 0) {
      countdownValueEl.textContent = "Completed";
      return;
    }

    var totalSeconds = Math.floor(diff / 1000);
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    if (days > 0) {
      countdownValueEl.textContent =
        pad(days) + ":" + pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
    } else {
      countdownValueEl.textContent =
        pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
    }
  }

  /* ---------- 7b. Live class (derived from timetable + clock) ---------- */
  /* Slot ranges in minutes-since-midnight, parallel to timeSlots. */
  var SLOT_RANGES = [
    [8 * 60, 9 * 60],
    [9 * 60, 10 * 60],
    [10 * 60 + 30, 11 * 60 + 30],
    [11 * 60 + 30, 12 * 60 + 30],
    [13 * 60 + 15, 14 * 60 + 15],
    [14 * 60 + 15, 15 * 60 + 15],
    [15 * 60 + 15, 16 * 60],
  ];

  var JS_DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  function getSubjectLabel(id) {
    if (!isValidSubjectId(id)) return "";
    var def = subjectDefinitions[id];
    return def.shortCode || def.code || def.name || "";
  }

  function formatEndsIn(minsLeft) {
    if (minsLeft <= 0) return "ending now";
    if (minsLeft < 60) return "ends in " + minsLeft + "m";
    var h = Math.floor(minsLeft / 60);
    var m = minsLeft % 60;
    return m === 0 ? "ends in " + h + "h" : "ends in " + h + "h " + m + "m";
  }

  function formatSlotEnd(slotIndex) {
    var parts = timeSlots[slotIndex].split("-");
    return parts.length > 1 ? parts[1].trim() : timeSlots[slotIndex];
  }

  function formatSlotStart(slotIndex) {
    var parts = timeSlots[slotIndex].split("-");
    return parts.length > 0 ? parts[0].trim() : timeSlots[slotIndex];
  }

  /* Scan forward from (dayName, slotIndexExclusive) for the next placed
   * class today, then day-by-day through Saturday, wrapping to next Monday.
   * Sunday is always skipped (no teaching days). Returns null when the
   * whole timetable is empty. */
  function findNextClass(dayName, slotIndexExclusive) {
    var startDayIdx = dayOrder.indexOf(dayName);
    var hasAnyClass = dayOrder.some(function (d) {
      return timetable[d].some(isValidSubjectId);
    });
    if (!hasAnyClass) return null;
    /* Rest of today. */
    if (startDayIdx !== -1) {
      for (var s = slotIndexExclusive + 1; s < timeSlots.length; s++) {
        if (isValidSubjectId(timetable[dayName][s])) {
          return { day: dayName, slot: s, id: timetable[dayName][s], today: true };
        }
      }
      /* Later this week (Tue..Sat). */
      for (var d = startDayIdx + 1; d < dayOrder.length; d++) {
        for (var k = 0; k < timeSlots.length; k++) {
          if (isValidSubjectId(timetable[dayOrder[d]][k])) {
            return { day: dayOrder[d], slot: k, id: timetable[dayOrder[d]][k], today: false };
          }
        }
      }
    }
    /* Wrap to next week (Monday onward). */
    for (var w = 0; w < dayOrder.length; w++) {
      for (var j = 0; j < timeSlots.length; j++) {
        if (isValidSubjectId(timetable[dayOrder[w]][j])) {
          return { day: dayOrder[w], slot: j, id: timetable[dayOrder[w]][j], today: false };
        }
      }
    }
    return null;
  }

  function setLiveCard(isLive, label, value, hint) {
    if (!liveValueEl) return;
    liveLabelEl.textContent = label;
    liveValueEl.textContent = value;
    liveHintEl.textContent = hint;
    if (liveCardEl) liveCardEl.classList.toggle("is-live", !!isLive);
  }

  function updateLiveClass(nowOverride) {
    if (!liveValueEl) return;
    var now = nowOverride instanceof Date ? nowOverride : new Date();
    var dayName = JS_DAY_NAMES[now.getDay()];
    var mins = now.getHours() * 60 + now.getMinutes();

    /* Sunday: no teaching days. */
    if (dayName === "Sunday") {
      var nextAfterWeekend = findNextClass("Saturday", timeSlots.length);
      if (!nextAfterWeekend) {
        setLiveCard(false, "Live Class", "—", "");
      } else {
        setLiveCard(
          false,
          "Live Class",
          "Weekend",
          "Next: " + getSubjectLabel(nextAfterWeekend.id) + " · " + nextAfterWeekend.day + " " + formatSlotStart(nextAfterWeekend.slot),
        );
      }
      return;
    }

    var dayIdx = dayOrder.indexOf(dayName);
    if (dayIdx === -1) return;
    var today = timetable[dayName] || [];

    /* Inside a class slot? */
    var currentSlot = -1;
    for (var i = 0; i < SLOT_RANGES.length; i++) {
      if (mins >= SLOT_RANGES[i][0] && mins < SLOT_RANGES[i][1]) {
        currentSlot = i;
        break;
      }
    }

    if (currentSlot !== -1) {
      var currentId = today[currentSlot];
      if (isValidSubjectId(currentId)) {
        var def = subjectDefinitions[currentId];
        var minsLeft = SLOT_RANGES[currentSlot][1] - mins;
        var hint =
          formatDisplayText(def.name) +
          " · till " + formatSlotEnd(currentSlot) +
          " (" + formatEndsIn(minsLeft) + ")";
        if (def.faculty) hint += " · " + formatDisplayText(def.faculty);
        setLiveCard(true, "Live Now", getSubjectLabel(currentId), hint);
        return;
      }
      /* In-slot but empty = free period. */
      var nextInSlot = findNextClass(dayName, currentSlot);
      if (nextInSlot && nextInSlot.today) {
        setLiveCard(false, "Live Class", "Free Period", "Next: " + getSubjectLabel(nextInSlot.id) + " at " + formatSlotStart(nextInSlot.slot));
      } else if (nextInSlot) {
        setLiveCard(false, "Live Class", "Free Period", "Next: " + getSubjectLabel(nextInSlot.id) + " · " + nextInSlot.day + " " + formatSlotStart(nextInSlot.slot));
      } else {
        setLiveCard(false, "Live Class", "Free Period", "No more classes scheduled");
      }
      return;
    }

    /* Between slots = scheduled break (10:00-10:30, 12:30-13:15) or
     * outside teaching hours. Distinguish by checking whether we are
     * inside the teaching day span. */
    var dayStart = SLOT_RANGES[0][0];
    var dayEnd = SLOT_RANGES[SLOT_RANGES.length - 1][1];
    var next = findNextClass(dayName, -1);
    if (!next) {
      setLiveCard(false, "Live Class", "—", "");
      return;
    }
    if (mins < dayStart) {
      var firstToday = null;
      for (var f = 0; f < timeSlots.length; f++) {
        if (isValidSubjectId(today[f])) {
          firstToday = { slot: f, id: today[f] };
          break;
        }
      }
      if (firstToday) {
        setLiveCard(false, "Live Class", "Classes start " + formatSlotStart(firstToday.slot), "First: " + getSubjectLabel(firstToday.id));
      } else if (next) {
        setLiveCard(false, "Live Class", "No classes today", "Next: " + getSubjectLabel(next.id) + " · " + next.day + " " + formatSlotStart(next.slot));
      }
      return;
    }
    if (mins >= dayEnd) {
      if (next && !next.today) {
        setLiveCard(false, "Live Class", "Day Over", "Next: " + getSubjectLabel(next.id) + " · " + next.day + " " + formatSlotStart(next.slot));
      } else {
        setLiveCard(false, "Live Class", "Day Over", "No more classes scheduled");
      }
      return;
    }
    /* Mid-day gap = break. */
    var upcoming = findNextClass(dayName, -1);
    /* Find the slot we just passed to anchor the break message. */
    var passedSlot = -1;
    for (var b = 0; b < SLOT_RANGES.length; b++) {
      if (mins >= SLOT_RANGES[b][1]) passedSlot = b;
    }
    var nextToday = findNextClass(dayName, passedSlot);
    if (nextToday && nextToday.today) {
      setLiveCard(false, "Live Class", "Break", "Next: " + getSubjectLabel(nextToday.id) + " at " + formatSlotStart(nextToday.slot));
    } else if (upcoming && !upcoming.today) {
      setLiveCard(false, "Live Class", "Break", "Next: " + getSubjectLabel(upcoming.id) + " · " + upcoming.day + " " + formatSlotStart(upcoming.slot));
    } else {
      setLiveCard(false, "Live Class", "Break", "No more classes today");
    }
  }

  /* ---------- 8. Clock and date ---------- */
  function updateClock() {
    timeEl.textContent = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }

  function updateDate() {
    var now = new Date();
    var day = String(now.getDate()).padStart(2, "0");
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sept",
      "Oct",
      "Nov",
      "Dec",
    ];
    dateEl.textContent =
      day + " " + months[now.getMonth()] + ", " + now.getFullYear();
  }

  /* ---------- 9. Timetable + subject storage ---------- */
  function isValidStoredSubject(def) {
    return (
      def &&
      typeof def === "object" &&
      typeof def.name === "string" &&
      def.name.trim() !== "" &&
      typeof def.code === "string" &&
      typeof def.shortCode === "string" &&
      typeof def.faculty === "string" &&
      typeof def.color === "string"
    );
  }

  /* Custom (imported) subjects persist separately so the built-in
   * defaults in source code are never overwritten. */
  function loadCustomSubjects() {
    subjectDefinitions = cloneSubjects(defaultSubjectDefinitions);
    var saved = readStorage(SUBJECTS_STORAGE_KEY);
    if (!saved || typeof saved !== "object") return;
    Object.keys(saved).forEach(function (id) {
      if (
        typeof id === "string" &&
        id.indexOf("imported-") === 0 &&
        !Object.prototype.hasOwnProperty.call(subjectDefinitions, id) &&
        isValidStoredSubject(saved[id])
      ) {
      subjectDefinitions[id] = {
        code: saved[id].code,
        shortCode: saved[id].shortCode,
        name: saved[id].name,
        faculty: saved[id].faculty,
        type:
          saved[id].type === "lab" || saved[id].type === "other"
            ? saved[id].type
            : "lecture",
        color: saved[id].color,
      };
      }
    });
  }

  function saveCustomSubjects() {
    var custom = {};
    Object.keys(subjectDefinitions).forEach(function (id) {
      if (
        id.indexOf("imported-") === 0 &&
        !Object.prototype.hasOwnProperty.call(
          defaultSubjectDefinitions,
          id,
        )
      ) {
        custom[id] = subjectDefinitions[id];
      }
    });
    if (Object.keys(custom).length === 0) {
      removeStorage(SUBJECTS_STORAGE_KEY);
    } else {
      writeStorage(SUBJECTS_STORAGE_KEY, custom);
    }
  }

  function loadTimetable() {
    var saved = readStorage(TIMETABLE_STORAGE_KEY);
    if (!saved) return;
    dayOrder.forEach(function (day) {
      if (Array.isArray(saved[day]) && saved[day].length === timeSlots.length) {
        timetable[day] = saved[day].map(function (id) {
          return isValidSubjectId(id) ? id : null;
        });
      }
    });
  }

  function saveTimetable() {
    writeStorage(TIMETABLE_STORAGE_KEY, timetable);
  }

  function loadMetadata() {
    var saved = readStorage(METADATA_STORAGE_KEY);
    if (!saved || typeof saved !== "object") return;
    Object.keys(defaultMetadata).forEach(function (key) {
      if (typeof saved[key] === "string") {
        timetableMetadata[key] = saved[key]
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
      }
    });
  }

  function saveMetadata() {
    writeStorage(METADATA_STORAGE_KEY, timetableMetadata);
  }

  function renderMetadata() {
    Object.keys(metadataValues).forEach(function (key) {
      metadataValues[key].textContent = formatDisplayText(timetableMetadata[key]);
    });
  }

  function openMetadataEditor(triggerEl) {
    metadataTriggerEl = triggerEl || null;
    Object.keys(metadataModalInputs).forEach(function (key) {
      metadataModalInputs[key].value = timetableMetadata[key];
    });
    metadataModalEl.classList.add("open");
    metadataModalInputs.batch.focus();
  }

  function closeMetadataEditor() {
    metadataModalEl.classList.remove("open");
    if (metadataTriggerEl && document.contains(metadataTriggerEl)) {
      metadataTriggerEl.focus();
    }
    metadataTriggerEl = null;
  }

  function saveMetadataFromModal() {
    Object.keys(metadataModalInputs).forEach(function (key) {
      timetableMetadata[key] = metadataModalInputs[key].value
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    });
    saveMetadata();
    renderMetadata();
    closeMetadataEditor();
  }

  function resetTimetable() {
    if (!confirm("Are you sure you want to clear the timetable schedule?"))
      return;
    removeStorage(TIMETABLE_STORAGE_KEY);
    timetable = createEmptyTimetable();
    renderTimetable();
  }

  /* ---------- 10. Timetable rendering ---------- */
  function renderSlot(day, slotIndex) {
    var col = document.createElement("div");
    col.className = "col-slot";

    var body = document.createElement("div");
    var subjectId = timetable[day][slotIndex];
    var subject = isValidSubjectId(subjectId)
      ? subjectDefinitions[subjectId]
      : null;

    if (subject) {
      body.className = "slot-body editable";
      body.style.setProperty("--course-color", subject.color);

      var code = document.createElement("div");
      code.className = "course-code";
      var codeFull = document.createElement("span");
      codeFull.className = "code-full";
      codeFull.textContent = subject.code || subject.name;
      var codeAbbr = document.createElement("span");
      codeAbbr.className = "code-abbr";
      codeAbbr.textContent = subject.shortCode || subject.code || subject.name;
      code.appendChild(codeFull);
      code.appendChild(codeAbbr);

      var courseName = document.createElement("div");
      courseName.className = "course-name";
      courseName.textContent = formatDisplayText(subject.name);

      var faculty = document.createElement("div");
      faculty.className = "faculty";
      faculty.textContent = formatDisplayText(subject.faculty || "");

      body.appendChild(code);
      body.appendChild(courseName);
      if (subject.faculty) body.appendChild(faculty);
    } else {
      body.className = "slot-body empty editable";
      body.textContent = "";
      body.setAttribute("aria-label", "Empty slot — click to add a class");
    }

    body.setAttribute("tabindex", "0");
    body.setAttribute("role", "button");
    body.addEventListener("click", function () {
      openSubjectEditor(day, slotIndex, body);
    });
    body.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); /* Space must not scroll the page */
        openSubjectEditor(day, slotIndex, body);
      }
    });

    col.appendChild(body);
    return col;
  }

  function renderBreak() {
    var br = document.createElement("div");
    br.className = "col-break";
    var label = document.createElement("span");
    label.className = "break-label";
    label.textContent = "Break";
    br.appendChild(label);
    return br;
  }

  function renderTimetable() {
    /* Day rows are fully owned by JS (header row in HTML is static). */
    Array.prototype.slice
      .call(timetableEl.querySelectorAll(".row:not(.row-head)"))
      .forEach(function (row) {
        row.remove();
      });

    dayOrder.forEach(function (day) {
      var row = document.createElement("div");
      row.className = "row";

      var dayCol = document.createElement("div");
      dayCol.className = "col-day";
      var dayFull = document.createElement("span");
      dayFull.className = "day-full";
      dayFull.textContent = day;
      var dayShort = document.createElement("span");
      dayShort.className = "day-abbr";
      dayShort.textContent = dayAbbr[day];
      dayCol.appendChild(dayFull);
      dayCol.appendChild(dayShort);
      row.appendChild(dayCol);

      timetable[day].forEach(function (_, slotIndex) {
        row.appendChild(renderSlot(day, slotIndex));
        if (BREAK_AFTER_SLOTS.indexOf(slotIndex) !== -1) {
          row.appendChild(renderBreak());
        }
      });

      timetableEl.appendChild(row);
    });

    updateLiveClass();
  }

  /* ---------- 11. Subject editor modal ---------- */
  function buildSubjectOptions() {
    subjectSelect.textContent = "";
    Object.keys(subjectDefinitions).forEach(function (id) {
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent =
        subjectDefinitions[id].name +
        (subjectDefinitions[id].shortCode
          ? " (" + subjectDefinitions[id].shortCode + ")"
          : "");
      subjectSelect.appendChild(opt);
    });
  }

  function openSubjectEditor(day, slotIndex, triggerEl) {
    editingDay = day;
    editingSlot = slotIndex;
    subjectTriggerEl = triggerEl || null;

    var currentId = timetable[day][slotIndex];
    var isEmpty = !isValidSubjectId(currentId);

    subjectTitleEl.textContent = isEmpty ? "Add Class" : "Edit Class";
    subjectSubtitleEl.textContent =
      day +
      " · " +
      timeSlots[slotIndex] +
      (isEmpty ? "" : " · " + subjectDefinitions[currentId].name);

    buildSubjectOptions();
    if (!isEmpty) subjectSelect.value = currentId;
    subjectSaveBtn.textContent = isEmpty ? "Add" : "Save";
    subjectRemoveBtn.style.display = isEmpty ? "none" : "";

    subjectModalEl.classList.add("open");
    subjectSelect.focus();
  }

  function closeSubjectEditor() {
    subjectModalEl.classList.remove("open");
    editingDay =
      null; /* clear transient state so it can never leak into the next edit */
    editingSlot = -1;
    if (subjectTriggerEl && document.contains(subjectTriggerEl)) {
      subjectTriggerEl.focus();
    }
    subjectTriggerEl = null;
  }

  function saveSubjectChange() {
    if (editingDay == null || editingSlot < 0) return;
    var selected = subjectSelect.value;
    if (!isValidSubjectId(selected)) return;
    timetable[editingDay][editingSlot] = selected;
    saveTimetable();
    renderTimetable();
    closeSubjectEditor();
  }

  function removeSubject() {
    if (editingDay == null || editingSlot < 0) return;
    timetable[editingDay][editingSlot] = null;
    saveTimetable();
    renderTimetable();
    closeSubjectEditor();
  }

  /* ---------- 12. Countdown editor modal ---------- */
  function openCountdownEditor(triggerEl) {
    countdownTriggerEl = triggerEl || null;
    countdownNameInput.value =
      countdownTarget.title === "Countdown" ? "" : countdownTarget.title || "";
    if (countdownTarget.date != null) {
      var d = new Date(countdownTarget.date);
      countdownDateInput.value =
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      countdownTimeInput.value = pad(d.getHours()) + ":" + pad(d.getMinutes());
    } else {
      countdownDateInput.value = "";
      countdownTimeInput.value = "";
    }
    countdownModalEl.classList.add("open");
    countdownNameInput.focus();
  }

  function closeCountdownEditor() {
    countdownModalEl.classList.remove("open");
    if (countdownTriggerEl && document.contains(countdownTriggerEl)) {
      countdownTriggerEl.focus();
    }
    countdownTriggerEl = null;
  }

  function saveCountdownFromModal() {
    if (!countdownDateInput.value) {
      countdownDateInput.focus();
      return;
    }
    /* "YYYY-MM-DDTHH:MM" with no timezone suffix parses as LOCAL time. */
    var target = new Date(
      countdownDateInput.value + "T" + (countdownTimeInput.value || "00:00"),
    );
    if (isNaN(target.getTime())) {
      countdownDateInput.focus();
      return;
    }
    countdownTarget.title = countdownNameInput.value.trim() || "Countdown";
    countdownTarget.date = target.getTime();
    saveCountdown();
    updateCountdown();
    closeCountdownEditor();
  }

  function clearCountdown() {
    countdownTarget.title = "Countdown";
    countdownTarget.date = null;
    saveCountdown();
    updateCountdown();
    closeCountdownEditor();
  }

  /* ---------- 13. Shared modal helpers ---------- */
  function isModalOpen(modalEl) {
    return modalEl.classList.contains("open");
  }

  function bindBackdropClose(modalEl, closeFn) {
    modalEl.addEventListener("click", function (e) {
      if (e.target === modalEl)
        closeFn(); /* backdrop itself only, not inner clicks */
    });
  }

  /* ---------- 16. Screenshot import: backend AI analysis ---------- */
  /*
   * The browser NEVER calls Gemini directly and never sees any API key.
   * It POSTs the raw image file to same-origin
   * POST /api/analyze-timetable (multipart/form-data, field "image").
   * the backend forwards the image to Gemini, validates the structured
   * JSON, and returns normalized { success, days } — or
   * { success:false, error } which is shown verbatim (server messages
   * are already user-safe and key-free).
   *
   * The original screenshot bytes are sent untouched: no local OCR,
   * no pixel processing, no mapping against local subjects.
   */
  function analyzeImageViaBackend(file) {
    var form = new FormData();
    form.append("image", file, file.name || "timetable.png");
    return fetch("/api/analyze-timetable", {
      method: "POST",
      body: form,
    }).then(function (res) {
      return res.json().then(
        function (data) {
          if (!res.ok || !data || data.success !== true) {
            var msg =
              (data && typeof data.error === "string" && data.error) ||
              "Could not analyze this image. Please try a clearer screenshot.";
            var err = new Error(msg);
            err.status = res.status;
            throw err;
          }
          return data;
        },
        function () {
          throw new Error(
            "Could not analyze this image. Please check your connection and try again.",
          );
        },
      );
    });
  }

  /* Backend already validated; this is a defensive client-side shape
   * check so a malformed payload can never corrupt the live timetable. */
  function previewFromBackendDays(days) {
    if (!days || !Array.isArray(days)) throw new Error("Malformed analysis result.");
    var preview = {};
    dayOrder.forEach(function (day) {
      preview[day] = [null, null, null, null, null, null, null];
    });
    days.forEach(function (entry) {
      if (!entry || dayOrder.indexOf(entry.day) === -1) return;
      if (!Array.isArray(entry.slots)) return;
      preview[entry.day] = entry.slots.slice(0, timeSlots.length).map(function (cell) {
        if (cell === null || cell === undefined) return null;
        if (typeof cell !== "object") return null;
        var subject = typeof cell.subject === "string" ? cell.subject.trim() : "";
        var courseCode = typeof cell.courseCode === "string" ? cell.courseCode.trim() : "";
        var faculty = typeof cell.faculty === "string" ? cell.faculty.trim() : "";
        var type = cell.type === "lab" || cell.type === "other" ? cell.type : "lecture";
        if (subject === "" && courseCode === "" && faculty === "") return null;
        return {
          subject: subject,
          courseCode: courseCode,
          faculty: faculty,
          type: type,
          needsReview: cell.needsReview === true,
        };
      });
      while (preview[entry.day].length < timeSlots.length) preview[entry.day].push(null);
    });
    return preview;
  }

  function normalizeImportedMetadata(raw) {
    if (!raw || typeof raw !== "object") return null;
    var imported = {};
    var hasValue = false;
    Object.keys(defaultMetadata).forEach(function (key) {
      var value = typeof raw[key] === "string" ? raw[key].replace(/\s+/g, " ").trim().slice(0, 80) : null;
      imported[key] = value || null;
      if (imported[key]) hasValue = true;
    });
    return hasValue ? imported : null;
  }

  /* ---------- 17. Screenshot import: review model helpers ---------- */
  function isReviewCellValid(cell) {
    if (cell === null) return true;
    return (
      cell &&
      typeof cell === "object" &&
      typeof cell.subject === "string" &&
      cell.subject.trim() !== ""
    );
  }

  function isImportablePreview(preview) {
    if (!preview) return false;
    return dayOrder.every(function (day) {
      return (
        Array.isArray(preview[day]) &&
        preview[day].length === timeSlots.length &&
        preview[day].every(isReviewCellValid)
      );
    });
  }

  function deriveShortCode(code, name) {
    if (code) {
      var compact = code.replace(/\s+/g, " ").trim();
      if (compact.length <= 16) return compact;
      var tail = compact.split(" ").pop();
      return tail.slice(0, 16);
    }
    var words = String(name || "")
      .split(/[^A-Za-z0-9]+/)
      .filter(function (w) {
        return w !== "";
      });
    var initials = words
      .map(function (w) {
        return w.charAt(0).toUpperCase();
      })
      .join("")
      .slice(0, 5);
    return initials || "SUBJ";
  }

  function deriveCode(shortCode, name) {
    if (shortCode && shortCode !== "SUBJ") return shortCode;
    return String(name || "Subject").slice(0, 60);
  }

  /* Deduplicate reviewed cells into subject definitions + placement.
   * Same (name|code|faculty|type) reuses one definition. IDs are
   * generated locally and never sent to Gemini. */
  function buildImportSubjects(preview) {
    var defs = {};
    var placement = {};
    var paletteIndex = 0;
    var keyToId = {};

    function colorFor() {
      var c = IMPORT_COLOR_PALETTE[paletteIndex % IMPORT_COLOR_PALETTE.length];
      paletteIndex++;
      return c;
    }

    dayOrder.forEach(function (day) {
      placement[day] = preview[day].map(function (cell) {
        if (cell === null) return null;
        var name = cell.subject.trim();
        var code = (cell.courseCode || "").trim();
        var faculty = (cell.faculty || "").trim();
        var type = cell.type === "lab" || cell.type === "other" ? cell.type : "lecture";
        var key = [name.toLowerCase(), code.toLowerCase(), faculty.toLowerCase(), type].join("|");
        if (keyToId[key]) return keyToId[key];
        var id =
          "imported-" +
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2, 8);
        var shortCode = deriveShortCode(code, name);
        defs[id] = {
          code: code !== "" ? code : deriveCode("", name),
          shortCode: shortCode,
          name: name,
          faculty: faculty,
          type: type,
          color: colorFor(),
        };
        keyToId[key] = id;
        return id;
      });
    });

    return { defs: defs, placement: placement };
  }

  /* ---------- 18. Screenshot import: state + DOM ---------- */
  var IMPORT_ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
  var IMPORT_MAX_BYTES = 10 * 1024 * 1024;

  var importState = {
    step: "upload", /* upload | analyzing | review | done */
    fileName: "",
    file: null,
    imageDataUrl: null,
    previewObjectUrl: null,
    /* preview: day -> [null | { subject, courseCode, faculty, type, needsReview } x7] */
    preview: null,
    metadata: null,
  };
  var importTriggerEl = null;
  var toastTimer = null;

  var importBtn = document.getElementById("import-screenshot");
  var importModalEl = document.getElementById("import-modal");
  var importDropzone = document.getElementById("import-dropzone");
  var importFileInput = document.getElementById("import-file");
  var importChooseBtn = document.getElementById("import-choose");
  var importPreviewWrap = document.getElementById("import-preview-wrap");
  var importPreviewImg = document.getElementById("import-preview-img");
  var importFileName = document.getElementById("import-file-name");
  var importAnalyzeBtn = document.getElementById("import-analyze");
  var importCancelBtn = document.getElementById("import-cancel");
  var importErrorBox = document.getElementById("import-error");
  var importErrorMsg = document.getElementById("import-error-msg");
  var importRetryBtn = document.getElementById("import-retry");
  var importStepUpload = document.getElementById("import-step-upload");
  var importStepAnalyzing = document.getElementById("import-step-analyzing");
  var importStatusText = document.getElementById("import-status-text");
  var importStepReview = document.getElementById("import-step-review");
  var importStepDone = document.getElementById("import-step-done");
  var importReviewImg = document.getElementById("import-review-img");
  var importReviewList = document.getElementById("import-review-list");
  var importBackBtn = document.getElementById("import-back");
  var importConfirmBtn = document.getElementById("import-confirm");
  var importCloseBtn = document.getElementById("import-close");
  var toastEl = document.getElementById("toast");

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
      toastTimer = null;
    }, 3200);
  }

  function setImportStep(step) {
    importState.step = step;
    importStepUpload.hidden = step !== "upload";
    importStepAnalyzing.hidden = step !== "analyzing";
    importStepReview.hidden = step !== "review";
    importStepDone.hidden = step !== "done";
  }

  function showImportError(message) {
    importErrorMsg.textContent = message;
    importErrorBox.hidden = false;
  }

  function hideImportError() {
    importErrorBox.hidden = true;
    importErrorMsg.textContent = "";
  }

  function clearImportImage() {
    if (
      importState.previewObjectUrl &&
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      URL.revokeObjectURL(importState.previewObjectUrl);
    }
    importState.fileName = "";
    importState.file = null;
    importState.imageDataUrl = null;
    importState.previewObjectUrl = null;
    importFileInput.value = "";
    importPreviewImg.removeAttribute("src");
    importPreviewWrap.hidden = true;
    importFileName.textContent = "";
    importAnalyzeBtn.disabled = true;
  }

  function isSupportedImageFile(file) {
    if (!file) return false;
    if (IMPORT_ACCEPTED_TYPES.indexOf(file.type) !== -1) return true;
    return /\.(png|jpe?g|webp)$/i.test(file.name || "");
  }

  function handleImportFile(file) {
    hideImportError();
    if (!file) return;
    if (!isSupportedImageFile(file)) {
      showImportError("Unsupported file type. Please choose a PNG, JPG or WEBP image.");
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      showImportError("Image is too large. Please choose a file under 10 MB.");
      return;
    }
    importState.file = file;
    importState.fileName = file.name || "timetable screenshot";
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      clearPreviewObjectUrlOnly();
      importState.previewObjectUrl = URL.createObjectURL(file);
      importPreviewImg.src = importState.previewObjectUrl;
    }
    importPreviewWrap.hidden = false;
    importFileName.textContent = importState.fileName;
    if (typeof FileReader === "undefined") {
      /* Still analyzable via the File object itself; preview via object URL. */
      importState.imageDataUrl = importState.previewObjectUrl;
      importAnalyzeBtn.disabled = false;
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      importState.imageDataUrl =
        typeof reader.result === "string" ? reader.result : null;
      importAnalyzeBtn.disabled = !importState.imageDataUrl;
    };
    reader.onerror = function () {
      showImportError("Could not read this image. Please try another file.");
    };
    reader.readAsDataURL(file);
  }

  function clearPreviewObjectUrlOnly() {
    if (
      importState.previewObjectUrl &&
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      URL.revokeObjectURL(importState.previewObjectUrl);
      importState.previewObjectUrl = null;
    }
  }

  function openImportModal(triggerEl) {
    importTriggerEl = triggerEl || null;
    clearImportImage();
    hideImportError();
    importState.preview = null;
    importState.metadata = null;
    setImportStep("upload");
    importModalEl.classList.add("open");
    importChooseBtn.focus();
  }

  function closeImportModal() {
    importModalEl.classList.remove("open");
    clearImportImage();
    hideImportError();
    importState.preview = null;
    importState.metadata = null;
    if (importTriggerEl && document.contains(importTriggerEl)) {
      importTriggerEl.focus();
    }
    importTriggerEl = null;
  }

  /* ---------- 19. Screenshot import: analyze + review + import ---------- */
  function startImportAnalysis() {
    if (!importState.file || importState.step === "analyzing") return;
    hideImportError();
    importAnalyzeBtn.disabled = true; /* prevent duplicate submissions */
    if (importStatusText) {
      importStatusText.textContent = "Analyzing timetable with AI…";
    }
    setImportStep("analyzing");
    analyzeImageViaBackend(importState.file).then(
      function (data) {
        var preview;
        try {
          preview = previewFromBackendDays(data.days);
        } catch (e) {
          setImportStep("upload");
          importAnalyzeBtn.disabled = !importState.file;
          showImportError(
            "The analysis returned an unreadable result. Please try a clearer screenshot.",
          );
          return;
        }
        /* Never touch the live timetable here — review + confirm only. */
        importState.preview = preview;
        importState.metadata = normalizeImportedMetadata(data.metadata);
        renderImportReview();
        setImportStep("review");
        importConfirmBtn.focus();
      },
      function (err) {
        /* Never touch the live timetable on failure. No silent fallback
         * to the current timetable: show the error and let the user retry. */
        setImportStep("upload");
        importAnalyzeBtn.disabled = !importState.file;
        showImportError(
          (err && err.message) ||
            "Could not analyze this image. Please try a clearer screenshot.",
        );
      },
    );
  }

  /* Editable review: every cell can be corrected (subject, course code,
   * faculty, type, empty) before the user confirms the import. */
  function renderImportReview() {
    importReviewList.textContent = "";
    if (importState.imageDataUrl) {
      importReviewImg.src = importState.imageDataUrl;
    }
    dayOrder.forEach(function (day) {
      var dayBlock = document.createElement("div");
      dayBlock.className = "review-day";
      var title = document.createElement("div");
      title.className = "review-day-title";
      title.textContent = day;
      dayBlock.appendChild(title);

      importState.preview[day].forEach(function (cell, idx) {
        var card = document.createElement("div");
        card.className = "review-cell" + (cell === null ? " is-empty-cell" : "");

        var head = document.createElement("div");
        head.className = "review-cell-head";
        var time = document.createElement("span");
        time.className = "review-time";
        time.textContent = timeSlots[idx];
        head.appendChild(time);

        if (cell && cell.needsReview) {
          var badge = document.createElement("span");
          badge.className = "review-badge is-unknown";
          badge.textContent = "Needs review";
          head.appendChild(badge);
        }

        var toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "review-empty-toggle";
        toggle.textContent = cell === null ? "Add class" : "Mark empty";
        toggle.setAttribute(
          "aria-label",
          (cell === null ? "Add class on " : "Mark empty on ") + day + " " + timeSlots[idx],
        );
        toggle.addEventListener("click", function () {
          if (importState.preview[day][idx] === null) {
            importState.preview[day][idx] = {
              subject: "",
              courseCode: "",
              faculty: "",
              type: "lecture",
              needsReview: false,
            };
          } else {
            importState.preview[day][idx] = null;
          }
          renderImportReview();
        });
        head.appendChild(toggle);
        card.appendChild(head);

        if (cell !== null) {
          var subjectInput = document.createElement("input");
          subjectInput.type = "text";
          subjectInput.className = "review-input";
          subjectInput.placeholder = "Subject (required)";
          subjectInput.value = cell.subject || "";
          subjectInput.setAttribute("aria-label", "Subject on " + day + " " + timeSlots[idx]);
          subjectInput.maxLength = 200;
          subjectInput.addEventListener("input", function () {
            importState.preview[day][idx].subject = subjectInput.value;
            importState.preview[day][idx].needsReview = false;
            refreshImportConfirmState();
          });
          card.appendChild(subjectInput);

          var row2 = document.createElement("div");
          row2.className = "review-grid-2";
          var codeInput = document.createElement("input");
          codeInput.type = "text";
          codeInput.className = "review-input";
          codeInput.placeholder = "Course code (optional)";
          codeInput.value = cell.courseCode || "";
          codeInput.setAttribute("aria-label", "Course code on " + day + " " + timeSlots[idx]);
          codeInput.maxLength = 80;
          codeInput.addEventListener("input", function () {
            importState.preview[day][idx].courseCode = codeInput.value;
          });
          row2.appendChild(codeInput);

          var typeSelect = document.createElement("select");
          typeSelect.className = "review-select";
          typeSelect.setAttribute("aria-label", "Class type on " + day + " " + timeSlots[idx]);
          ["lecture", "lab", "other"].forEach(function (t) {
            var opt = document.createElement("option");
            opt.value = t;
            opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
            typeSelect.appendChild(opt);
          });
          typeSelect.value = cell.type === "lab" || cell.type === "other" ? cell.type : "lecture";
          typeSelect.addEventListener("change", function () {
            importState.preview[day][idx].type = typeSelect.value;
          });
          row2.appendChild(typeSelect);
          card.appendChild(row2);

          var facultyInput = document.createElement("input");
          facultyInput.type = "text";
          facultyInput.className = "review-input";
          facultyInput.placeholder = "Faculty (optional)";
          facultyInput.value = cell.faculty || "";
          facultyInput.setAttribute("aria-label", "Faculty on " + day + " " + timeSlots[idx]);
          facultyInput.maxLength = 120;
          facultyInput.addEventListener("input", function () {
            importState.preview[day][idx].faculty = facultyInput.value;
          });
          card.appendChild(facultyInput);

          if (!isReviewCellValid(cell)) {
            var hint = document.createElement("div");
            hint.className = "review-hint";
            hint.textContent = "Enter a subject name or mark this slot empty.";
            card.appendChild(hint);
          }
        } else {
          var emptyNote = document.createElement("div");
          emptyNote.className = "review-subject is-empty";
          emptyNote.textContent = "Empty";
          card.appendChild(emptyNote);
        }

        dayBlock.appendChild(card);
      });
      importReviewList.appendChild(dayBlock);
    });
    refreshImportConfirmState();
  }

  function refreshImportConfirmState() {
    importConfirmBtn.disabled = !isImportablePreview(importState.preview);
  }

  function confirmImport() {
    if (!isImportablePreview(importState.preview)) return;
    var built = buildImportSubjects(importState.preview);
    Object.keys(built.defs).forEach(function (id) {
      subjectDefinitions[id] = built.defs[id];
    });
    timetable = cloneTimetable(built.placement);
    if (importState.metadata) {
      Object.keys(importState.metadata).forEach(function (key) {
        if (importState.metadata[key]) timetableMetadata[key] = importState.metadata[key];
      });
      saveMetadata();
      renderMetadata();
    }
    saveCustomSubjects();
    saveTimetable(); /* existing storage system + key */
    renderTimetable(); /* existing renderer is the only presentation layer */
    setImportStep("done");
    importCloseBtn.focus();
    showToast("Timetable imported successfully.");
  }

  function getImportFocusables() {
    var nodes = importModalEl.querySelectorAll(
      "button:not([disabled]), input, select, [tabindex]",
    );
    return Array.prototype.slice.call(nodes).filter(function (el) {
      return el.getAttribute("tabindex") !== "-1" && el.offsetParent !== null;
    });
  }

  /* ---------- 14. Event binding (registered once; never inside render) ---------- */
  function bindEvents() {
    /* Countdown card */
    countdownCardEl.addEventListener("click", function () {
      openCountdownEditor(countdownCardEl);
    });
    countdownCardEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCountdownEditor(countdownCardEl);
      }
    });

    /* Countdown modal */
    countdownSaveBtn.addEventListener("click", saveCountdownFromModal);
    countdownCancelBtn.addEventListener("click", closeCountdownEditor);
    countdownClearBtn.addEventListener("click", clearCountdown);
    bindBackdropClose(countdownModalEl, closeCountdownEditor);

    /* Subject modal */
    subjectSaveBtn.addEventListener("click", saveSubjectChange);
    subjectRemoveBtn.addEventListener("click", removeSubject);
    subjectCancelBtn.addEventListener("click", closeSubjectEditor);
    bindBackdropClose(subjectModalEl, closeSubjectEditor);

    /* Reset */
    resetBtn.addEventListener("click", resetTimetable);

    /* Timetable metadata uses the same modal interaction as the countdown. */
    metadataTrigger.addEventListener("click", function () {
      openMetadataEditor(metadataTrigger);
    });
    metadataTrigger.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMetadataEditor(metadataTrigger);
      }
    });
    metadataSaveBtn.addEventListener("click", saveMetadataFromModal);
    metadataCancelBtn.addEventListener("click", closeMetadataEditor);
    metadataModalEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        saveMetadataFromModal();
      }
    });
    bindBackdropClose(metadataModalEl, closeMetadataEditor);

    /* Screenshot import */
    importBtn.addEventListener("click", function () {
      openImportModal(importBtn);
    });
    importChooseBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      importFileInput.click();
    });
    importFileInput.addEventListener("change", function () {
      handleImportFile(importFileInput.files && importFileInput.files[0]);
    });
    importDropzone.addEventListener("click", function (e) {
      if (e.target === importChooseBtn || importChooseBtn.contains(e.target)) return;
      importFileInput.click();
    });
    importDropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        importFileInput.click();
      }
    });
    ["dragenter", "dragover"].forEach(function (type) {
      importDropzone.addEventListener(type, function (e) {
        e.preventDefault();
        importDropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      importDropzone.addEventListener(type, function (e) {
        e.preventDefault();
        importDropzone.classList.remove("dragover");
      });
    });
    importDropzone.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      handleImportFile(files && files[0]);
    });
    importAnalyzeBtn.addEventListener("click", startImportAnalysis);
    importCancelBtn.addEventListener("click", closeImportModal);
    importRetryBtn.addEventListener("click", function () {
      clearImportImage();
      hideImportError();
      importChooseBtn.focus();
    });
    importBackBtn.addEventListener("click", function () {
      setImportStep("upload");
      importAnalyzeBtn.disabled = !importState.file;
      importChooseBtn.focus();
    });
    importConfirmBtn.addEventListener("click", confirmImport);
    importCloseBtn.addEventListener("click", closeImportModal);
    bindBackdropClose(importModalEl, function () {
      if (importState.step !== "analyzing") closeImportModal();
    });

    /* Escape closes the topmost open modal only */
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (isModalOpen(importModalEl)) {
        if (importState.step !== "analyzing") closeImportModal();
      } else if (isModalOpen(metadataModalEl)) {
        closeMetadataEditor();
      } else if (isModalOpen(subjectModalEl)) {
        closeSubjectEditor();
      } else if (isModalOpen(countdownModalEl)) {
        closeCountdownEditor();
      }
    });

    /* Focus trap for the import modal */
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Tab" || !isModalOpen(importModalEl)) return;
      var focusables = getImportFocusables();
      if (focusables.length === 0) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  /* ---------- 15. Initialization ---------- */
  loadCountdown();
  loadCustomSubjects();
  loadTimetable();
  loadMetadata();
  bindEvents();
  updateClock();
  updateDate();
  updateCountdown();
  renderMetadata();
  renderTimetable();
  updateLiveClass();
  setInterval(updateClock, 1000);
  setInterval(updateCountdown, 1000);
  setInterval(updateLiveClass, 15000);
  setInterval(updateDate, DATE_REFRESH_MS);

  void escapeHtml;
})();
