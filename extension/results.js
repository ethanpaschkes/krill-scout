// Runs inside the game page itself so it can see the result of YOUR OWN answers (the same reply the game
// shows you: accepted or not, and the tier). It never sends anything anywhere; it only tells Krill Scout,
// which uses it to learn your tier cut-offs. It does not read answer sheets.
(() => {
  const realFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await realFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input.url;
      // krillion.io answers go to /submit, playdaily.org's copy of the game to /api/krillion/answer.
      if (/\/(submit|api\/krillion\/answer)(\?|$)/.test(url) && init?.body) {
        const sent = JSON.parse(init.body);
        response
          .clone()
          .json()
          .then((reply) => {
            if (reply.correction) return;
            window.postMessage({ krillScoutResult: { answer: reply.answer || sent.answer, tier: reply.accepted ? reply.tier : "miss" } }, location.origin);
          })
          .catch(() => {});
      }
    } catch {}
    return response;
  };
})();
