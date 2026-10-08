function sanitizeText(text) {
  if (!text) return text;
  return (
    text
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x09/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
      .trim()
  );
}

module.exports = { sanitizeText };
