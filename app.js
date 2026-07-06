/* =====================================================================
   Transfert playlist YouTube -> Spotify — logique applicative
   Version FILE D'ATTENTE (backend séquentiel type Soundiiz) :
   - le bouton AJOUTE la playlist à une file traitée en arrière-plan ;
   - la section « File de transfert » liste chaque playlist avec son
     état (en attente n°k / en cours / terminé / erreur), rendue via
     createElement + textContent UNIQUEMENT (CSP stricte, pas d'innerHTML) ;
   - le polling (backoff + jitter) tourne tant qu'au moins un job est
     actif et s'arrête seul ; plus de garde-fou 15 min (une file peut
     légitimement être longue), les GET de statut sont peu coûteux.
   Les recommandations de la revue de sécurité (#1 … #25) sont conservées.
   ===================================================================== */

(function () {
    "use strict";

    /* ---------------------------------------------------------------
       (#22) Configuration — gelée pour empêcher toute réécriture runtime
       --------------------------------------------------------------- */
    const CONFIG = Object.freeze({
        SPOTIFY_LOGIN_WEBHOOK: "https://everywhere.app.n8n.cloud/webhook/spotify-login",
        TRANSFER_WEBHOOK:      "https://everywhere.app.n8n.cloud/webhook/transfert-playlist",
        STATUS_WEBHOOK:        "https://everywhere.app.n8n.cloud/webhook/transfert-status",
        // (#20) Endpoint de télémétrie facultatif. null = rien n'est envoyé.
        TELEMETRY_WEBHOOK:     null,

        POLL_INITIAL_MS:  3000,   // (#8) délai initial
        POLL_MAX_MS:      15000,  // (#8) plafond du backoff (file = longue durée possible)
        FETCH_TIMEOUT_MS: 12000,  // (#9) timeout par requête
        MAX_NAME_LEN:     100     // (#13) longueur max du nom
    });

    /* =================================================================
       (i18n) Dictionnaires FR / EN / ES — gelés, rendus via textContent
       ================================================================= */
    const I18N = Object.freeze({
        fr: Object.freeze({
            "doc.title":        "Transférer une playlist YouTube → Spotify",
            "ad.label":         "Publicité",
            "hero.line1":       "Fais voyager ta playlist",
            "hero.line2":       "de YouTube vers Spotify",
            "hero.lede":        "Connecte ton compte Spotify, colle le lien de ta playlist YouTube, et on s'occupe du reste.",
            "step1":            "Connexion Spotify",
            "step2":            "Ta playlist",
            "step3":            "File de transfert",
            "login":            "Connecter Spotify",
            "connectedBadge":   "Spotify : connecté",
            "logout":           "Déconnecter",
            "name.label":       "Nom de la playlist",
            "name.placeholder": "Ex : Road Trip 2026",
            "url.label":        "Lien de la playlist YouTube",
            "transfer":         "Ajouter à la file →",
            "footnote":         "Tes identifiants Spotify ne transitent jamais par ce site : la connexion se fait directement sur",
            "status.redirect":  "Redirection vers Spotify…",
            "status.loggedOut": "Compte Spotify déconnecté.",
            "status.connected": "Compte Spotify connecté avec succès.",
            "status.enqueued":  "Playlist ajoutée à la file. Le transfert démarre automatiquement.",
            "status.already":   "Cette playlist est déjà dans la file.",
            "job.queued":       "En attente",
            "job.position":     "n°{n}",
            "job.running":      "En cours",
            "job.done":         "Terminé",
            "job.error":        "Erreur",
            "job.willStart":    "Démarrera automatiquement.",
            "job.inProgress":   "Transfert en cours…",
            "job.doneDefault":  "Transfert terminé.",
            "job.errorDefault": "Une erreur est survenue.",
            "job.open":         "Ouvrir dans Spotify",
            "err.connectFirst": "Connecte d'abord ton compte Spotify (étape 1).",
            "err.name":         "Renseigne le nom de la playlist (100 caractères max).",
            "err.url":          "Lien de playlist YouTube invalide. Vérifie le format (paramètre list=…).",
            "err.launch":       "Erreur lors de l'ajout à la file.",
            "err.timeout":      "Délai dépassé : le serveur n'a pas répondu à temps. Réessaie.",
            "err.network":      "Erreur réseau. Vérifie ta connexion."
        }),
        en: Object.freeze({
            "doc.title":        "Transfer a YouTube playlist → Spotify",
            "ad.label":         "Advertisement",
            "hero.line1":       "Send your playlist",
            "hero.line2":       "from YouTube to Spotify",
            "hero.lede":        "Connect your Spotify account, paste your YouTube playlist link, and we'll handle the rest.",
            "step1":            "Connect Spotify",
            "step2":            "Your playlist",
            "step3":            "Transfer queue",
            "login":            "Connect Spotify",
            "connectedBadge":   "Spotify: connected",
            "logout":           "Log out",
            "name.label":       "Playlist name",
            "name.placeholder": "E.g. Road Trip 2026",
            "url.label":        "YouTube playlist link",
            "transfer":         "Add to queue →",
            "footnote":         "Your Spotify credentials never pass through this site: you sign in directly on",
            "status.redirect":  "Redirecting to Spotify…",
            "status.loggedOut": "Spotify account disconnected.",
            "status.connected": "Spotify account connected successfully.",
            "status.enqueued":  "Playlist added to the queue. The transfer starts automatically.",
            "status.already":   "This playlist is already in the queue.",
            "job.queued":       "Queued",
            "job.position":     "#{n}",
            "job.running":      "In progress",
            "job.done":         "Done",
            "job.error":        "Error",
            "job.willStart":    "Will start automatically.",
            "job.inProgress":   "Transfer in progress…",
            "job.doneDefault":  "Transfer complete.",
            "job.errorDefault": "An error occurred.",
            "job.open":         "Open in Spotify",
            "err.connectFirst": "Connect your Spotify account first (step 1).",
            "err.name":         "Enter a playlist name (100 characters max).",
            "err.url":          "Invalid YouTube playlist link. Check the format (list=… parameter).",
            "err.launch":       "Error while adding to the queue.",
            "err.timeout":      "Timed out: the server didn't respond in time. Please try again.",
            "err.network":      "Network error. Check your connection."
        }),
        es: Object.freeze({
            "doc.title":        "Transferir una playlist de YouTube → Spotify",
            "ad.label":         "Publicidad",
            "hero.line1":       "Lleva tu playlist",
            "hero.line2":       "de YouTube a Spotify",
            "hero.lede":        "Conecta tu cuenta de Spotify, pega el enlace de tu playlist de YouTube y nosotros nos ocupamos del resto.",
            "step1":            "Conexión con Spotify",
            "step2":            "Tu playlist",
            "step3":            "Cola de transferencia",
            "login":            "Conectar Spotify",
            "connectedBadge":   "Spotify: conectado",
            "logout":           "Desconectar",
            "name.label":       "Nombre de la playlist",
            "name.placeholder": "Ej.: Road Trip 2026",
            "url.label":        "Enlace de la playlist de YouTube",
            "transfer":         "Añadir a la cola →",
            "footnote":         "Tus credenciales de Spotify nunca pasan por este sitio: inicias sesión directamente en",
            "status.redirect":  "Redirigiendo a Spotify…",
            "status.loggedOut": "Cuenta de Spotify desconectada.",
            "status.connected": "Cuenta de Spotify conectada correctamente.",
            "status.enqueued":  "Playlist añadida a la cola. La transferencia empieza automáticamente.",
            "status.already":   "Esta playlist ya está en la cola.",
            "job.queued":       "En espera",
            "job.position":     "n.º {n}",
            "job.running":      "En curso",
            "job.done":         "Completado",
            "job.error":        "Error",
            "job.willStart":    "Empezará automáticamente.",
            "job.inProgress":   "Transferencia en curso…",
            "job.doneDefault":  "Transferencia completada.",
            "job.errorDefault": "Se produjo un error.",
            "job.open":         "Abrir en Spotify",
            "err.connectFirst": "Conecta primero tu cuenta de Spotify (paso 1).",
            "err.name":         "Indica el nombre de la playlist (máx. 100 caracteres).",
            "err.url":          "Enlace de playlist de YouTube no válido. Comprueba el formato (parámetro list=…).",
            "err.launch":       "Error al añadir a la cola.",
            "err.timeout":      "Tiempo agotado: el servidor no respondió a tiempo. Vuelve a intentarlo.",
            "err.network":      "Error de red. Comprueba tu conexión."
        })
    });

    const SUPPORTED_LANGS = Object.freeze(["fr", "en", "es"]);
    let currentLang = "fr";

    /* (i18n) t() : lookup + interpolation {n} — la valeur interpolée est
       toujours convertie en chaîne et injectée via textContent ensuite. */
    function t(key, params) {
        const dict = I18N[currentLang] || I18N.fr;
        let text = dict[key] || I18N.fr[key] || key;
        if (params) {
            for (const p of Object.keys(params)) {
                text = text.split("{" + p + "}").join(String(params[p]));
            }
        }
        return text;
    }

    function detectLang() {
        const saved = localStorage.getItem("lang");
        if (SUPPORTED_LANGS.includes(saved)) return saved;
        const candidates = navigator.languages || [navigator.language || "en"];
        for (const c of candidates) {
            const prefix = String(c).slice(0, 2).toLowerCase();
            if (SUPPORTED_LANGS.includes(prefix)) return prefix;
        }
        return "en";
    }

    /* (i18n) Applique la langue à tout le document. Jamais d'innerHTML. */
    function applyLang(lang) {
        if (!SUPPORTED_LANGS.includes(lang)) lang = "en";
        currentLang = lang;
        try { localStorage.setItem("lang", lang); } catch (_) { /* stockage bloqué */ }

        document.documentElement.lang = lang;
        document.title = t("doc.title");

        document.querySelectorAll("[data-i18n]").forEach((el) => {
            el.textContent = t(el.getAttribute("data-i18n"));
        });
        document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
            el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
        });
        document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
            el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
        });

        document.querySelectorAll(".lang-btn").forEach((btn) => {
            const active = btn.getAttribute("data-lang") === lang;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-pressed", active ? "true" : "false");
        });

        // (i18n) re-rendu de la file dans la nouvelle langue
        renderJobs(lastJobs);
    }

    /* ---------------------------------------------------------------
       État interne
       --------------------------------------------------------------- */
    let pollTimer = null;      // setTimeout courant du polling
    let isSubmitting = false;  // (#11) garde anti double-clic sur l'enfilage
    let lastJobs = [];         // dernier état connu de la file (pour re-rendu i18n)

    /* ---------------------------------------------------------------
       Helpers DOM
       --------------------------------------------------------------- */
    const $ = (id) => document.getElementById(id);

    /* ---------------------------------------------------------------
       (#20)(#12) Journalisation des erreurs
       --------------------------------------------------------------- */
    function reportError(context, error) {
        // eslint-disable-next-line no-console
        console.error("[transfert]", context, error);
        if (!CONFIG.TELEMETRY_WEBHOOK) return;
        try {
            const payload = JSON.stringify({
                context: context,
                message: error && error.message ? error.message : String(error),
                ts: new Date().toISOString(),
                ua: navigator.userAgent
            });
            if (navigator.sendBeacon) {
                navigator.sendBeacon(CONFIG.TELEMETRY_WEBHOOK, payload);
            }
        } catch (_) { /* on n'échoue jamais sur la télémétrie */ }
    }

    /* ---------------------------------------------------------------
       (#18)(#10) Identité de session (sessionStorage + rotation)
       --------------------------------------------------------------- */
    function generateId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        if (window.crypto && crypto.getRandomValues) {
            const buf = new Uint8Array(16);
            crypto.getRandomValues(buf);
            return "session-" + Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
        }
        return "session-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    }

    function getOrCreateSessionId() {
        let sessionId = sessionStorage.getItem("sessionId");
        if (!sessionId) {
            sessionId = generateId();
            sessionStorage.setItem("sessionId", sessionId);
        }
        return sessionId;
    }

    function rotateSession() {
        const fresh = generateId();
        sessionStorage.setItem("sessionId", fresh);
        sessionStorage.setItem("csrfToken", generateId()); // (#3)
        return fresh;
    }

    function getCsrfToken() {
        let token = sessionStorage.getItem("csrfToken");
        if (!token) {
            token = generateId();
            sessionStorage.setItem("csrfToken", token);
        }
        return token;
    }

    /* ---------------------------------------------------------------
       (#9) fetch avec timeout (AbortController)
       --------------------------------------------------------------- */
    async function fetchWithTimeout(url, opts = {}, ms = CONFIG.FETCH_TIMEOUT_MS) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), ms);
        try {
            return await fetch(url, { ...opts, signal: controller.signal });
        } finally {
            clearTimeout(id);
        }
    }

    /* (#3) En-têtes communs des appels POST vers n8n */
    function jsonHeaders() {
        return {
            "Content-Type": "application/json",
            "X-CSRF-Token": getCsrfToken()
        };
    }

    /* ---------------------------------------------------------------
       UI : état de connexion Spotify
       --------------------------------------------------------------- */
    function setSpotifyConnectedUI(isConnected) {
        $("spotifyLoginBtn").classList.toggle("hidden", isConnected);
        $("spotifyConnectedBadge").classList.toggle("hidden", !isConnected);
        $("transferBtn").disabled = !isConnected || isSubmitting;
    }

    function restoreSpotifyState() {
        setSpotifyConnectedUI(sessionStorage.getItem("spotifyConnected") === "true");
    }

    /* ---------------------------------------------------------------
       (#24) Messages inline (textContent uniquement — #13)
       --------------------------------------------------------------- */
    function setStatus(text, kind) {
        const status = $("statusMessage");
        status.className = "status" + (kind ? " " + kind : "");
        status.textContent = text || "";
    }

    /* ---------------------------------------------------------------
       Connexion / déconnexion Spotify
       --------------------------------------------------------------- */
    function loginSpotify() {
        const sessionId = rotateSession(); // (#10)
        setStatus(t("status.redirect"));
        window.location.href = `${CONFIG.SPOTIFY_LOGIN_WEBHOOK}?sessionId=${encodeURIComponent(sessionId)}`;
    }

    function logoutSpotify() {
        stopPolling();
        sessionStorage.removeItem("spotifyConnected");
        rotateSession(); // (#10)
        setSpotifyConnectedUI(false);
        setStatus(t("status.loggedOut"));
        lastJobs = [];
        renderJobs(lastJobs); // la nouvelle session n'a plus d'historique visible
        document.body.classList.remove("is-transferring");
    }

    function handleSpotifyReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("spotify") === "success") {
            sessionStorage.setItem("spotifyConnected", "true");
            setStatus(t("status.connected"), "success");
            setSpotifyConnectedUI(true);
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
        }
    }

    /* ---------------------------------------------------------------
       (#13) Validation/normalisation du nom de playlist
       --------------------------------------------------------------- */
    function sanitizeName(raw) {
        const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
        return cleaned.slice(0, CONFIG.MAX_NAME_LEN);
    }

    /* (#7)(#23) Extraction robuste de l'ID de playlist YouTube */
    function extractPlaylistId(input) {
        const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
        const value = (input || "").trim();
        try {
            const u = new URL(value);
            const list = u.searchParams.get("list");
            if (list && ID_RE.test(list)) return list;
        } catch (_) { /* pas une URL : peut-être l'ID seul */ }
        if (ID_RE.test(value)) return value;
        return null;
    }

    /* ---------------------------------------------------------------
       (#17) Validation stricte du schéma de réponse de statut (file)
       Schéma attendu : { jobs: [{ jobId, playlistName, status, step,
                          total, recap, playlistUrl, position }] }
       --------------------------------------------------------------- */
    const JOB_STATUSES = Object.freeze(["queued", "running", "done", "error"]);

    function parseJobs(data) {
        if (!data || typeof data !== "object" || !Array.isArray(data.jobs)) return [];
        return data.jobs.slice(0, 50).map((j) => {
            if (!j || typeof j !== "object") return null;
            const status = JOB_STATUSES.includes(j.status) ? j.status : "queued";
            // (#13) le lien n'est accepté que s'il pointe vers open.spotify.com en https
            let playlistUrl = null;
            if (typeof j.playlistUrl === "string" && /^https:\/\/open\.spotify\.com\//.test(j.playlistUrl)) {
                playlistUrl = j.playlistUrl.slice(0, 300);
            }
            return {
                jobId:        typeof j.jobId === "string" ? j.jobId.slice(0, 200) : "",
                playlistName: typeof j.playlistName === "string" ? j.playlistName.slice(0, CONFIG.MAX_NAME_LEN) : "",
                status:       status,
                step:         typeof j.step === "string" ? j.step.slice(0, 200) : null,
                total:        typeof j.total === "number" ? j.total : null,
                recap:        typeof j.recap === "string" ? j.recap.slice(0, 1000) : null,
                playlistUrl:  playlistUrl,
                position:     (typeof j.position === "number" && j.position > 0) ? Math.floor(j.position) : null
            };
        }).filter(Boolean);
    }

    /* ---------------------------------------------------------------
       Rendu de la file — exclusivement createElement + textContent (#13)
       --------------------------------------------------------------- */
    function badgeFor(job) {
        const span = document.createElement("span");
        span.className = "badge " + job.status;
        let label = t("job." + job.status);
        if (job.status === "queued" && job.position) {
            label += " · " + t("job.position", { n: job.position });
        }
        span.textContent = label;
        return span;
    }

    function renderJobs(jobs) {
        const list = $("jobsList");
        const section = $("queueSection");
        if (!list || !section) return;

        list.replaceChildren(); // vide sans innerHTML
        if (!jobs || !jobs.length) {
            section.classList.add("hidden");
            return;
        }
        section.classList.remove("hidden");

        for (const job of jobs) {
            const card = document.createElement("div");
            card.className = "job-card job-" + job.status;

            if (job.status === "running") {
                const spin = document.createElement("div");
                spin.className = "mini-spinner";
                spin.setAttribute("aria-hidden", "true");
                card.appendChild(spin);
            }

            const info = document.createElement("div");
            info.className = "job-info";

            const name = document.createElement("div");
            name.className = "job-name";
            name.textContent = job.playlistName || "Playlist";
            info.appendChild(name);

            const step = document.createElement("div");
            step.className = "job-step";
            if (job.status === "queued") {
                step.textContent = t("job.willStart");
            } else if (job.status === "running") {
                step.textContent = job.step || t("job.inProgress");
            } else if (job.status === "done") {
                step.textContent = job.recap || t("job.doneDefault");
                if (job.playlistUrl) {
                    step.appendChild(document.createTextNode(" "));
                    const a = document.createElement("a");
                    a.href = job.playlistUrl; // validé par parseJobs (open.spotify.com)
                    a.target = "_blank";
                    a.rel = "noopener noreferrer";
                    a.textContent = t("job.open");
                    step.appendChild(a);
                }
            } else { // error
                step.textContent = job.recap || t("job.errorDefault");
            }
            info.appendChild(step);
            card.appendChild(info);
            card.appendChild(badgeFor(job));
            list.appendChild(card);
        }
    }

    /* ---------------------------------------------------------------
       Polling de la file — backoff + jitter (#8), timeout par tick (#9)
       Tourne tant qu'un job est queued/running, puis s'arrête seul.
       --------------------------------------------------------------- */
    function stopPolling() {
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function startPolling() {
        stopPolling();
        let delay = CONFIG.POLL_INITIAL_MS;

        async function tick() {
            let active = false;
            try {
                const sessionId = getOrCreateSessionId();
                const res = await fetchWithTimeout(
                    `${CONFIG.STATUS_WEBHOOK}?sessionId=${encodeURIComponent(sessionId)}`,
                    { cache: "no-store", headers: { "X-CSRF-Token": getCsrfToken() } }
                );
                const raw = await res.json().catch(() => ({}));
                lastJobs = parseJobs(raw);
                renderJobs(lastJobs);
                active = lastJobs.some((j) => j.status === "queued" || j.status === "running");
                document.body.classList.toggle("is-transferring",
                    lastJobs.some((j) => j.status === "running"));
            } catch (e) {
                reportError("poll", e); // (#12)
                active = true;          // erreur transitoire : on continue d'essayer
            }

            if (!active) {
                stopPolling();
                return;
            }
            delay = Math.min(delay * 1.5 + Math.random() * 1000, CONFIG.POLL_MAX_MS);
            pollTimer = setTimeout(tick, delay);
        }

        pollTimer = setTimeout(tick, 0); // premier tick immédiat
    }

    /* ---------------------------------------------------------------
       Ajout d'une playlist à la file
       --------------------------------------------------------------- */
    async function enqueuePlaylist() {
        if (isSubmitting) return; // (#11)

        if (sessionStorage.getItem("spotifyConnected") !== "true") {
            setStatus(t("err.connectFirst"), "error");
            return;
        }

        const playlistName = sanitizeName($("playlistName").value); // (#13)
        const playlistId = extractPlaylistId($("playlistUrl").value); // (#7)

        if (!playlistName) {
            setStatus(t("err.name"), "error");
            $("playlistName").focus();
            return;
        }
        if (!playlistId) {
            setStatus(t("err.url"), "error");
            $("playlistUrl").focus();
            return;
        }

        isSubmitting = true;
        $("transferBtn").disabled = true;
        setStatus("");

        try {
            const response = await fetchWithTimeout(CONFIG.TRANSFER_WEBHOOK, {
                method: "POST",
                headers: jsonHeaders(), // (#3) CSRF
                body: JSON.stringify({
                    sessionId: getOrCreateSessionId(),
                    playlistId: playlistId,
                    playlistName: playlistName,
                    lang: currentLang
                })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                const msg = data && typeof data.message === "string"
                    ? data.message.slice(0, 500)
                    : t("err.launch");
                setStatus(msg, "error");
                return;
            }

            if (data.status === "queued") {
                setStatus(t("status.enqueued"), "success");
                $("playlistName").value = "";
                $("playlistUrl").value = "";
            } else if (data.status === "already_queued" || data.status === "already_running") {
                setStatus(t("status.already"), "success");
            } else {
                setStatus(t("err.launch"), "error");
            }

            startPolling(); // rafraîchit la liste immédiatement, puis backoff

        } catch (e) {
            reportError("enqueue", e);
            const aborted = e && e.name === "AbortError";
            setStatus(aborted ? t("err.timeout") : t("err.network"), "error");
        } finally {
            isSubmitting = false;
            $("transferBtn").disabled = sessionStorage.getItem("spotifyConnected") !== "true";
        }
    }

    /* ---------------------------------------------------------------
       (#14)(#21) Publicité différée + robuste aux bloqueurs
       --------------------------------------------------------------- */
    window.googletag = window.googletag || { cmd: [] };

    function initAds() {
        let adSlot = null;
        try {
            googletag.cmd.push(function () {
                try {
                    const mapping = googletag.sizeMapping()
                        .addSize([1024, 0], [[970, 250], [728, 90], [320, 100]])
                        .addSize([768, 0],  [[728, 90], [320, 100]])
                        .addSize([0, 0],    [[320, 100], [300, 250]])
                        .build();

                    adSlot = googletag.defineSlot(
                        "/123456789/spotify_top_banner",
                        [[970, 250], [728, 90], [320, 100], [300, 250]],
                        "div-gpt-ad-top-banner"
                    )
                    .defineSizeMapping(mapping)
                    .addService(googletag.pubads());

                    googletag.pubads().disableInitialLoad(); // (#14)
                    googletag.pubads().enableSingleRequest();
                    googletag.enableServices();
                } catch (e) {
                    reportError("ads-config", e);
                }
            });

            googletag.cmd.push(function () {
                try {
                    googletag.display("div-gpt-ad-top-banner");
                    if (adSlot) googletag.pubads().refresh([adSlot]);
                } catch (e) {
                    reportError("ads-display", e); // (#21)
                }
            });
        } catch (e) {
            reportError("ads-init", e);
        }
    }

    /* ---------------------------------------------------------------
       Câblage des événements (pas d'onclick inline -> CSP stricte #5)
       --------------------------------------------------------------- */
    function init() {
        applyLang(detectLang());
        document.querySelectorAll(".lang-btn").forEach((btn) => {
            btn.addEventListener("click", () => applyLang(btn.getAttribute("data-lang")));
        });

        $("spotifyLoginBtn").addEventListener("click", loginSpotify);
        $("spotifyLogoutBtn").addEventListener("click", logoutSpotify);
        $("transferBtn").addEventListener("click", enqueuePlaylist);

        ["playlistName", "playlistUrl"].forEach((id) => {
            $(id).addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") enqueuePlaylist();
            });
        });

        restoreSpotifyState();
        handleSpotifyReturn();
        startPolling(); // restaure l'état de la file au chargement (s'arrête seul si vide)
        initAds();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
