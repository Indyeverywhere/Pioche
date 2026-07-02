/* =====================================================================
   Transfert playlist YouTube -> Spotify — logique applicative
   Les améliorations issues de la revue de sécurité/résilience sont
   repérées par le n° de recommandation (#1 … #21) en commentaire.
   Compléments de cette version :
   - (#22) config gelée (Object.freeze) : non modifiable depuis la console
   - (#23) borne haute sur l'ID de playlist + troncature des chaînes serveur
   - (#24) plus d'alert() : erreurs affichées inline (textContent only)
   - (#25) champs désactivés pendant un transfert
   - (i18n) FR / EN / ES : détection auto (navigator.languages),
     choix mémorisé (localStorage), rendu via textContent UNIQUEMENT.
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
        // (#19) Endpoint d'annulation à créer côté n8n (no-op tant qu'il n'existe pas).
        CANCEL_WEBHOOK:        "https://everywhere.app.n8n.cloud/webhook/transfert-cancel",
        // (#20) Endpoint de télémétrie facultatif. null = rien n'est envoyé.
        TELEMETRY_WEBHOOK:     null,

        POLL_INITIAL_MS:  3000,            // (#8) délai initial
        POLL_MAX_MS:      30000,           // (#8) plafond du backoff
        MAX_POLL_MS:      15 * 60 * 1000,  // garde-fou global : 15 min
        FETCH_TIMEOUT_MS: 12000,           // (#9) timeout par requête
        MAX_NAME_LEN:     100              // (#13) longueur max du nom
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
            "login":            "Connecter Spotify",
            "connectedBadge":   "Spotify : connecté",
            "logout":           "Déconnecter",
            "name.label":       "Nom de la playlist",
            "name.placeholder": "Ex : Road Trip 2026",
            "url.label":        "Lien de la playlist YouTube",
            "transfer":         "Transférer →",
            "cancel":           "Annuler",
            "footnote":         "Tes identifiants Spotify ne transitent jamais par ce site : la connexion se fait directement sur",
            "status.redirect":  "Redirection vers Spotify…",
            "status.loggedOut": "Compte Spotify déconnecté.",
            "status.connected": "Compte Spotify connecté avec succès.",
            "progress.default": "Transfert en cours",
            "progress.tracks":  "Traitement de {n} titres",
            "progress.retry":   "Connexion perdue, nouvelle tentative…",
            "result.done":      "Transfert terminé. Ta playlist t'attend sur Spotify !",
            "result.error":     "Une erreur est survenue pendant le transfert.",
            "result.tooLong":   "Le transfert prend plus de temps que prévu. Il se poursuit en arrière-plan, reviens dans quelques minutes.",
            "result.cancelled": "Transfert annulé.",
            "err.connectFirst": "Connecte d'abord ton compte Spotify (étape 1).",
            "err.name":         "Renseigne le nom de la playlist (100 caractères max).",
            "err.url":          "Lien de playlist YouTube invalide. Vérifie le format (paramètre list=…).",
            "err.launch":       "Erreur lors du lancement du transfert.",
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
            "login":            "Connect Spotify",
            "connectedBadge":   "Spotify: connected",
            "logout":           "Log out",
            "name.label":       "Playlist name",
            "name.placeholder": "E.g. Road Trip 2026",
            "url.label":        "YouTube playlist link",
            "transfer":         "Transfer →",
            "cancel":           "Cancel",
            "footnote":         "Your Spotify credentials never pass through this site: you sign in directly on",
            "status.redirect":  "Redirecting to Spotify…",
            "status.loggedOut": "Spotify account disconnected.",
            "status.connected": "Spotify account connected successfully.",
            "progress.default": "Transfer in progress",
            "progress.tracks":  "Processing {n} tracks",
            "progress.retry":   "Connection lost, retrying…",
            "result.done":      "Transfer complete. Your playlist is waiting on Spotify!",
            "result.error":     "An error occurred during the transfer.",
            "result.tooLong":   "The transfer is taking longer than expected. It continues in the background — check back in a few minutes.",
            "result.cancelled": "Transfer cancelled.",
            "err.connectFirst": "Connect your Spotify account first (step 1).",
            "err.name":         "Enter a playlist name (100 characters max).",
            "err.url":          "Invalid YouTube playlist link. Check the format (list=… parameter).",
            "err.launch":       "Error while starting the transfer.",
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
            "login":            "Conectar Spotify",
            "connectedBadge":   "Spotify: conectado",
            "logout":           "Desconectar",
            "name.label":       "Nombre de la playlist",
            "name.placeholder": "Ej.: Road Trip 2026",
            "url.label":        "Enlace de la playlist de YouTube",
            "transfer":         "Transferir →",
            "cancel":           "Cancelar",
            "footnote":         "Tus credenciales de Spotify nunca pasan por este sitio: inicias sesión directamente en",
            "status.redirect":  "Redirigiendo a Spotify…",
            "status.loggedOut": "Cuenta de Spotify desconectada.",
            "status.connected": "Cuenta de Spotify conectada correctamente.",
            "progress.default": "Transferencia en curso",
            "progress.tracks":  "Procesando {n} canciones",
            "progress.retry":   "Conexión perdida, reintentando…",
            "result.done":      "Transferencia completada. ¡Tu playlist te espera en Spotify!",
            "result.error":     "Se produjo un error durante la transferencia.",
            "result.tooLong":   "La transferencia está tardando más de lo previsto. Continúa en segundo plano; vuelve dentro de unos minutos.",
            "result.cancelled": "Transferencia cancelada.",
            "err.connectFirst": "Conecta primero tu cuenta de Spotify (paso 1).",
            "err.name":         "Indica el nombre de la playlist (máx. 100 caracteres).",
            "err.url":          "Enlace de playlist de YouTube no válido. Comprueba el formato (parámetro list=…).",
            "err.launch":       "Error al iniciar la transferencia.",
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

    /* (i18n) Détection : choix mémorisé > langue(s) du navigateur > anglais.
       On ne lit que le préfixe ("fr-FR" -> "fr") et on ignore toute valeur
       hors liste blanche (une valeur forgée en localStorage est sans effet). */
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

    /* (i18n) Applique la langue à tout le document.
       - data-i18n            -> textContent
       - data-i18n-placeholder -> attribut placeholder
       - data-i18n-aria        -> attribut aria-label
       Jamais d'innerHTML : aucune chaîne n'est interprétée comme du HTML. */
    function applyLang(lang) {
        if (!SUPPORTED_LANGS.includes(lang)) lang = "en";
        currentLang = lang;
        try { localStorage.setItem("lang", lang); } catch (_) { /* stockage plein/bloqué */ }

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

        // Libellé de progression par défaut (s'il n'affiche pas une étape serveur)
        if ($("progressWrapper").classList.contains("hidden")) {
            $("progressLabel").textContent = t("progress.default");
        }

        // Bouton actif dans le sélecteur
        document.querySelectorAll(".lang-btn").forEach((btn) => {
            const active = btn.getAttribute("data-lang") === lang;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }

    /* ---------------------------------------------------------------
       État interne
       --------------------------------------------------------------- */
    let pollTimer = null;        // setTimeout courant du polling
    let isTransferring = false;  // (#11) garde anti-spam du bouton

    /* ---------------------------------------------------------------
       Helpers DOM
       --------------------------------------------------------------- */
    const $ = (id) => document.getElementById(id);

    /* ---------------------------------------------------------------
       (#20)(#12) Journalisation des erreurs
       Console en dev + envoi best-effort vers une télémétrie si configurée.
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
            // sendBeacon : non bloquant, survit à la navigation
            if (navigator.sendBeacon) {
                navigator.sendBeacon(CONFIG.TELEMETRY_WEBHOOK, payload);
            }
        } catch (_) { /* on n'échoue jamais sur la télémétrie */ }
    }

    /* ---------------------------------------------------------------
       (#18)(#10) Identité de session
       - stockée en sessionStorage (effacée à la fermeture de l'onglet)
       - rotation à la connexion et à la déconnexion
       - on ne stocke QU'un identifiant de session, jamais un secret
       --------------------------------------------------------------- */
    function generateId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        // Repli : getRandomValues reste cryptographiquement sûr
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
        // (#3) un jeton CSRF distinct, lié à la session, régénéré à la rotation
        sessionStorage.setItem("csrfToken", generateId());
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

    /* ---------------------------------------------------------------
       (#3) En-têtes communs des appels POST vers n8n
       Un en-tête personnalisé (X-CSRF-Token) ne peut pas être posé en
       cross-origin sans accord CORS du serveur : il constitue à lui seul
       une protection CSRF, à condition que n8n le VALIDE.
       --------------------------------------------------------------- */
    function jsonHeaders() {
        return {
            "Content-Type": "application/json",
            "X-CSRF-Token": getCsrfToken()
        };
    }

    /* ---------------------------------------------------------------
       UI : état de connexion Spotify
       Rappel : ce flag pilote uniquement l'affichage. La frontière de
       sécurité réelle est la revalidation côté n8n à chaque requête (#4).
       --------------------------------------------------------------- */
    function setSpotifyConnectedUI(isConnected) {
        $("spotifyLoginBtn").classList.toggle("hidden", isConnected);
        $("spotifyConnectedBadge").classList.toggle("hidden", !isConnected);
        $("transferBtn").disabled = !isConnected || isTransferring;
    }

    function restoreSpotifyState() {
        setSpotifyConnectedUI(sessionStorage.getItem("spotifyConnected") === "true");
    }

    /* ---------------------------------------------------------------
       (#25) Verrouillage des champs pendant un transfert
       + hook visuel body.is-transferring (accélère l'animation du pont)
       --------------------------------------------------------------- */
    function setTransferringUI(active) {
        isTransferring = active;
        document.body.classList.toggle("is-transferring", active);
        $("playlistName").disabled = active;
        $("playlistUrl").disabled = active;
        $("transferBtn").disabled = active || sessionStorage.getItem("spotifyConnected") !== "true";
    }

    /* ---------------------------------------------------------------
       (#24) Messages d'erreur inline (plus d'alert bloquant)
       Sortie exclusivement via textContent — jamais innerHTML (#13)
       --------------------------------------------------------------- */
    function setStatus(text, kind) {
        const status = $("statusMessage");
        status.className = "status" + (kind ? " " + kind : "");
        status.textContent = text || "";
    }

    /* ---------------------------------------------------------------
       Connexion / déconnexion Spotify
       (#2) Idéalement, le sessionId ne devrait pas transiter en query
       string (historique, logs, Referer). Tant que le webhook n8n de
       login est en GET, on le passe en query ; si tu bascules le webhook
       en POST, remplace cette navigation par un <form method="POST">
       dynamique (form-action de la CSP l'autorise déjà).
       --------------------------------------------------------------- */
    function loginSpotify() {
        // (#10) nouvelle connexion = nouvelle session
        const sessionId = rotateSession();
        setStatus(t("status.redirect"));
        window.location.href = `${CONFIG.SPOTIFY_LOGIN_WEBHOOK}?sessionId=${encodeURIComponent(sessionId)}`;
    }

    function logoutSpotify() {
        stopPolling();
        setTransferringUI(false);
        sessionStorage.removeItem("spotifyConnected");
        rotateSession(); // (#10) on jette l'ancienne session
        setSpotifyConnectedUI(false);
        setStatus(t("status.loggedOut"));
    }

    /* ---------------------------------------------------------------
       Retour OAuth : ?spotify=success
       (le paramètre n'est pas un secret ; on nettoie quand même l'URL)
       --------------------------------------------------------------- */
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
       Progression / résultat (sortie via textContent uniquement — #13)
       --------------------------------------------------------------- */
    function showProgress(label) {
        $("resultBox").classList.add("hidden");
        $("progressLabel").textContent = label || t("progress.default");
        $("progressWrapper").classList.remove("hidden");
        $("cancelBtn").classList.remove("hidden");
    }

    function hideProgress() {
        $("progressWrapper").classList.add("hidden");
        $("cancelBtn").classList.add("hidden");
    }

    function showResult(text, isError) {
        hideProgress();
        const box = $("resultBox");
        box.textContent = text;                 // jamais innerHTML
        box.className = "result-box " + (isError ? "ko" : "ok");
        box.classList.remove("hidden");
    }

    /* ---------------------------------------------------------------
       (#13) Validation/normalisation du nom de playlist
       --------------------------------------------------------------- */
    function sanitizeName(raw) {
        // supprime les caractères de contrôle, trim, tronque
        const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
        return cleaned.slice(0, CONFIG.MAX_NAME_LEN);
    }

    /* ---------------------------------------------------------------
       (#7)(#23) Extraction robuste de l'ID de playlist YouTube
       API URL + validation stricte du charset ET bornes de longueur
       (10 à 64 caractères : couvre tous les formats connus de YouTube
       tout en bloquant les payloads démesurés).
       --------------------------------------------------------------- */
    function extractPlaylistId(input) {
        const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
        const value = (input || "").trim();

        try {
            const u = new URL(value);
            const list = u.searchParams.get("list");
            if (list && ID_RE.test(list)) return list;
        } catch (_) {
            // pas une URL : l'utilisateur a peut-être collé l'ID seul
        }
        if (ID_RE.test(value)) return value;
        return null;
    }

    /* ---------------------------------------------------------------
       (#17) Validation stricte du schéma de réponse de statut
       Schéma attendu : { status: "running"|"done"|"error",
                          step?, total?, recap? }
       --------------------------------------------------------------- */
    function parseStatus(data) {
        if (!data || typeof data !== "object") return { status: "running" };
        const allowed = ["running", "done", "error"];
        const status = allowed.includes(data.status) ? data.status : "running";
        return {
            status: status,
            step: typeof data.step === "string" ? data.step.slice(0, 200) : undefined,
            total: typeof data.total === "number" ? data.total : undefined,
            recap: typeof data.recap === "string" ? data.recap.slice(0, 1000) : undefined
        };
    }

    /* ---------------------------------------------------------------
       Polling
       --------------------------------------------------------------- */
    function stopPolling() {
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function finishTransfer() {
        setTransferringUI(false);
    }

    // (#8) backoff exponentiel + jitter, via setTimeout récursif (#9 timeout par tick)
    function startPolling(sessionId) {
        const startedAt = Date.now();
        let delay = CONFIG.POLL_INITIAL_MS;
        stopPolling();

        async function tick() {
            if (Date.now() - startedAt > CONFIG.MAX_POLL_MS) {
                stopPolling();
                showResult(t("result.tooLong"), true);
                finishTransfer();
                return;
            }

            try {
                const res = await fetchWithTimeout(
                    `${CONFIG.STATUS_WEBHOOK}?sessionId=${encodeURIComponent(sessionId)}`,
                    { cache: "no-store", headers: { "X-CSRF-Token": getCsrfToken() } }
                );
                const raw = await res.json().catch(() => ({}));
                const data = parseStatus(raw);

                if (data.status === "done") {
                    stopPolling();
                    showResult(data.recap || t("result.done"), false);
                    finishTransfer();
                    return;
                }
                if (data.status === "error") {
                    stopPolling();
                    showResult(data.recap || t("result.error"), true);
                    finishTransfer();
                    return;
                }

                // running : on met à jour le libellé puis on replanifie
                showProgress(
                    data.step ||
                    (data.total ? t("progress.tracks", { n: data.total }) : t("progress.default"))
                );
                delay = Math.min(delay * 1.5 + Math.random() * 1000, CONFIG.POLL_MAX_MS); // (#8) backoff + jitter
                pollTimer = setTimeout(tick, delay);

            } catch (e) {
                // (#12) on n'avale plus l'erreur en silence
                reportError("poll", e);
                showProgress(t("progress.retry"));
                delay = Math.min(delay * 1.5, CONFIG.POLL_MAX_MS);
                pollTimer = setTimeout(tick, delay);
            }
        }

        pollTimer = setTimeout(tick, delay);
    }

    /* ---------------------------------------------------------------
       (#19) Annulation
       --------------------------------------------------------------- */
    async function cancelTransfer() {
        stopPolling();
        const sessionId = getOrCreateSessionId();
        showResult(t("result.cancelled"), true);
        finishTransfer();
        try {
            await fetchWithTimeout(CONFIG.CANCEL_WEBHOOK, {
                method: "POST",
                headers: jsonHeaders(),
                body: JSON.stringify({ sessionId: sessionId })
            });
        } catch (e) {
            reportError("cancel", e); // best-effort : l'UI est déjà revenue à l'état stable
        }
    }

    /* ---------------------------------------------------------------
       Lancement du transfert
       --------------------------------------------------------------- */
    async function sendToN8n() {
        if (isTransferring) return; // (#11) anti double-clic / re-trigger console

        if (sessionStorage.getItem("spotifyConnected") !== "true") {
            setStatus(t("err.connectFirst"), "error");
            return;
        }

        const playlistName = sanitizeName($("playlistName").value); // (#13)
        const url = $("playlistUrl").value;
        const sessionId = getOrCreateSessionId();

        if (!playlistName) {
            setStatus(t("err.name"), "error");
            $("playlistName").focus();
            return;
        }

        const playlistId = extractPlaylistId(url); // (#7)
        if (!playlistId) {
            setStatus(t("err.url"), "error");
            $("playlistUrl").focus();
            return;
        }

        setTransferringUI(true); // (#11)(#25)
        setStatus("");
        $("resultBox").classList.add("hidden");
        showProgress(t("progress.default"));

        try {
            const response = await fetchWithTimeout(CONFIG.TRANSFER_WEBHOOK, {
                method: "POST",
                headers: jsonHeaders(),            // (#3) CSRF
                body: JSON.stringify({
                    sessionId: sessionId,
                    playlistId: playlistId,
                    playlistName: playlistName,
                    lang: currentLang              // (i18n) permet à n8n de répondre dans la bonne langue
                })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                const msg = data && typeof data.message === "string"
                    ? data.message.slice(0, 500)
                    : t("err.launch");
                showResult(msg, true);
                finishTransfer();
                return;
            }

            // Transfert accepté -> on passe en polling
            startPolling(sessionId);

        } catch (e) {
            reportError("transfer", e);
            const aborted = e && e.name === "AbortError";
            showResult(aborted ? t("err.timeout") : t("err.network"), true);
            finishTransfer();
        }
    }

    /* ---------------------------------------------------------------
       (#14)(#21) Publicité différée + robuste aux bloqueurs
       - configuration après DOMContentLoaded
       - disableInitialLoad() + refresh() pour ne pas bloquer le rendu
       - googletag.display enveloppé dans try/catch
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

                    googletag.pubads().disableInitialLoad();   // (#14) ne pas charger au boot
                    googletag.pubads().enableSingleRequest();
                    googletag.enableServices();
                } catch (e) {
                    reportError("ads-config", e);
                }
            });

            // Affichage + chargement différés une fois la page prête
            googletag.cmd.push(function () {
                try {
                    googletag.display("div-gpt-ad-top-banner");
                    if (adSlot) googletag.pubads().refresh([adSlot]);
                } catch (e) {
                    reportError("ads-display", e); // (#21) bloqueur de pub -> on n'interrompt rien
                }
            });
        } catch (e) {
            // gpt.js bloqué/absent : l'appli reste 100% fonctionnelle
            reportError("ads-init", e);
        }
    }

    /* ---------------------------------------------------------------
       Câblage des événements (plus aucun onclick inline -> CSP stricte #5)
       --------------------------------------------------------------- */
    function init() {
        // (i18n) détection auto + sélecteur manuel
        applyLang(detectLang());
        document.querySelectorAll(".lang-btn").forEach((btn) => {
            btn.addEventListener("click", () => applyLang(btn.getAttribute("data-lang")));
        });

        $("spotifyLoginBtn").addEventListener("click", loginSpotify);
        $("spotifyLogoutBtn").addEventListener("click", logoutSpotify);
        $("transferBtn").addEventListener("click", sendToN8n);
        $("cancelBtn").addEventListener("click", cancelTransfer);

        // Entrée dans un champ = lancer le transfert
        ["playlistName", "playlistUrl"].forEach((id) => {
            $(id).addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") sendToN8n();
            });
        });

        restoreSpotifyState();
        handleSpotifyReturn();
        initAds();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
