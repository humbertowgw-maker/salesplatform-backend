const BLAND_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeBlandCallId(value) {
  if (typeof value !== "string" || !BLAND_CALL_ID_PATTERN.test(value)) return null;
  return value;
}

function blandCallUrl(callId) {
  const safeId = normalizeBlandCallId(callId);
  if (!safeId) return null;
  return `https://us.api.bland.ai/v1/calls/${encodeURIComponent(safeId)}`;
}

module.exports = { blandCallUrl, normalizeBlandCallId };
