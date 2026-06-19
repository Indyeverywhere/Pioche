/* =====================================================================
   Transfert playlist YouTube -> Spotify — logique applicative
   Toutes les améliorations issues de la revue de sécurité/résilience sont
   repérées par le n° de recommandation (#1 … #21) en commentaire.
   ===================================================================== */

(function () {
    "use strict";

    /* ---------------------------------------------------------------
       Configuration
       --------------------------------------------------------------- */
    const SPOTIFY_LOGIN_WEBHOOK = "https://everywhere.app.n8n.cloud/webhook/spotify-login";
    const TRANSFER_WEBHOOK      = "https://everywhere.app.n8n.cloud/webhook/transfert-playlist";
    const STATUS_WEBHOOK        = "https://everywhere.app.n8n.cloud/webhook/transfert-status";
    // (#19) Endpoint d'annulation à créer côté n8n (no-op tant qu'il n'existe pas).
    const CANCEL_WEBHOOK        = "https://everywhere.app.n8n.cloud/webhook/transfert-cancel";
    // (#20) Endpoint de télémétrie facultatif. Laisser null pour ne rien envoyer.
    const TELEMETRY_WEBHOOK     = null;

    const POLL_INITIAL_MS = 3000;          // (#8) délai initial
    const POLL_MAX_MS     = 30000;         // (#8) plafond du backoff
    const MAX_POLL_MS     = 15 * 60 * 1000;// garde-fou global : 15 min
    const FETCH_TIMEOUT_MS = 12000;        // (#9) timeout par requête
    const MAX_NAME_LEN    = 100;           // (#13) longueur max du nom

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
        if (!TELEMETRY_WEBHOOK) return;
        try {
            const payload = JSON.stringify({
                context: context,
                message: error && error.message ? error.message : String(error),
                ts: new Date().toISOString(),
                ua: navigator.userAgent
            });
            // sendBeacon : non bloquant, survit à la navigation
            if (navigator.sendBeacon) {
                navigator.sendBeacon(TELEMETRY_WEBHOOK, payload);
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
    async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
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
       (#2) Connexion Spotify SANS sessionId dans l'URL
       On déclenche une navigation top-level en POST (formulaire dynamique)
       au lieu de window.location.href = "...?sessionId=...".
       -> sessionId/csrf ne fuitent plus dans l'historique, les logs serveur
          ni l'en-tête Referer.
       NB : le webhook n8n de login doit lire ces champs dans le CORPS POST.
       --------------------------------------------------------------- */
    function loginSpotify() {
        // (#10) nouvelle connexion = nouvelle session
        const sessionId = rotateSession();

        const status = $("statusMessage");
        status.className = "status";
        status.textContent = "Redirection vers Spotify…";

        const form = document.createElement("form");
        form.method = "POST";
        form.action = SPOTIFY_LOGIN_WEBHOOK;
        form.style.display = "none";

        const addField = (name, value) => {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = name;
            input.value = value;
            form.appendChild(input);
        };
        addField("sessionId", sessionId);
        addField("csrfToken", getCsrfToken());

        document.body.appendChild(form);
        form.submit();
    }

    function logoutSpotify() {
        stopPolling();
        isTransferring = false;
        sessionStorage.removeItem("spotifyConnected");
        rotateSession(); // (#10) on jette l'ancienne session
        setSpotifyConnectedUI(false);
        const status = $("statusMessage");
        status.className = "status";
        status.textContent = "Compte Spotify déconnecté.";
    }

    /* ---------------------------------------------------------------
       Retour OAuth : ?spotify=success
       (le paramètre n'est pas un secret ; on nettoie quand même l'URL)
       --------------------------------------------------------------- */
    function handleSpotifyReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("spotify") === "success") {
            sessionStorage.setItem("spotifyConnected", "true");
            const status = $("statusMessage");
            status.className = "status success";
            status.textContent = "Compte Spotify connecté avec succès.";
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
        $("progressLabel").textContent = label || "Transfert en cours";
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
        return cleaned.slice(0, MAX_NAME_LEN);
    }

    /* ---------------------------------------------------------------
       (#7) Extraction robuste de l'ID de playlist YouTube
       Utilise l'API URL + validation stricte du charset/longueur.
       --------------------------------------------------------------- */
    function extractPlaylistId(input) {
        const ID_RE = /^[A-Za-z0-9_-]{10,}$/;
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
            step: typeof data.step === "string" ? data.step : undefined,
            total: typeof data.total === "number" ? data.total : undefined,
            recap: typeof data.recap === "string" ? data.recap : undefined
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
        isTransferring = false;
        $("transferBtn").disabled = sessionStorage.getItem("spotifyConnected") !== "true";
    }

    // (#8) backoff exponentiel + jitter, via setTimeout récursif (#9 timeout par tick)
    function startPolling(sessionId) {
        const startedAt = Date.now();
        let delay = POLL_INITIAL_MS;
        stopPolling();

        async function tick() {
            if (Date.now() - startedAt > MAX_POLL_MS) {
                stopPolling();
                showResult(
                    "Le transfert prend plus de temps que prévu. Il se poursuit en arrière-plan, reviens dans quelques minutes.",
                    true
                );
                finishTransfer();
                return;
            }

            try {
                const res = await fetchWithTimeout(
                    `${STATUS_WEBHOOK}?sessionId=${encodeURIComponent(sessionId)}`,
                    { cache: "no-store", headers: { "X-CSRF-Token": getCsrfToken() } }
                );
                const raw = await res.json().catch(() => ({}));
                const data = parseStatus(raw);

                if (data.status === "done") {
                    stopPolling();
                    showResult(data.recap || "Transfert terminé.", false);
                    finishTransfer();
                    return;
                }
                if (data.status === "error") {
                    stopPolling();
                    showResult(data.recap || "Une erreur est survenue pendant le transfert.", true);
                    finishTransfer();
                    return;
                }

                // running : on met à jour le libellé puis on replanifie
                showProgress(
                    data.step ||
                    (data.total ? `Traitement de ${data.total} titres` : "Transfert en cours")
                );
                delay = Math.min(delay * 1.5 + Math.random() * 1000, POLL_MAX_MS); // (#8) backoff + jitter
                pollTimer = setTimeout(tick, delay);

            } catch (e) {
                // (#12) on n'avale plus l'erreur en silence
                reportError("poll", e);
                showProgress("Connexion perdue, nouvelle tentative…");
                delay = Math.min(delay * 1.5, POLL_MAX_MS);
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
        showResult("Transfert annulé.", true);
        finishTransfer();
        try {
            await fetchWithTimeout(CANCEL_WEBHOOK, {
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
            alert("Merci de connecter Spotify avant de lancer le transfert.");
            return;
        }

        const playlistName = sanitizeName($("playlistName").value); // (#13)
        const url = $("playlistUrl").value;
        const sessionId = getOrCreateSessionId();
        const status = $("statusMessage");

        if (!playlistName) {
            alert("Merci de renseigner le nom de la playlist (100 caractères max).");
            return;
        }

        const playlistId = extractPlaylistId(url); // (#7)
        if (!playlistId) {
            alert("Lien de playlist YouTube invalide. Vérifie le format (paramètre list=…).");
            return;
        }

        isTransferring = true;
        $("transferBtn").disabled = true;
        status.className = "status";
        status.textContent = "";
        $("resultBox").classList.add("hidden");
        showProgress("Transfert en cours");

        try {
            const response = await fetchWithTimeout(TRANSFER_WEBHOOK, {
                method: "POST",
                headers: jsonHeaders(),            // (#3) CSRF
                body: JSON.stringify({
                    sessionId: sessionId,
                    playlistId: playlistId,
                    playlistName: playlistName
                })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                const msg = data && data.message ? data.message : "Erreur lors du lancement du transfert.";
                showResult(msg, true);
                finishTransfer();
                return;
            }

            // Transfert accepté -> on passe en polling
            startPolling(sessionId);

        } catch (e) {
            reportError("transfer", e);
            const aborted = e && e.name === "AbortError";
            showResult(
                aborted
                    ? "Délai dépassé : le serveur n'a pas répondu à temps. Réessaie."
                    : "Erreur réseau. Vérifie ta connexion.",
                true
            );
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
        $("spotifyLoginBtn").addEventListener("click", loginSpotify);
        $("spotifyLogoutBtn").addEventListener("click", logoutSpotify);
        $("transferBtn").addEventListener("click", sendToN8n);
        $("cancelBtn").addEventListener("click", cancelTransfer);

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
