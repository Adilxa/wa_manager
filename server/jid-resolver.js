const LID_SUFFIX = "@lid";
const PN_SUFFIX = "@s.whatsapp.net";
const GROUP_SUFFIX = "@g.us";

const lidMappingsByAccount = new Map();

function safeDecode(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function jidUser(jid) {
  return safeDecode(jid).split("@")[0].split(":")[0];
}

function isLidJid(jid) {
  return safeDecode(jid).endsWith(LID_SUFFIX);
}

function isPnJid(jid) {
  return safeDecode(jid).endsWith(PN_SUFFIX);
}

function isGroupJid(jid) {
  return safeDecode(jid).endsWith(GROUP_SUFFIX);
}

function toBareJid(jid) {
  const value = safeDecode(jid);
  if (!value.includes("@")) return value;

  const server = value.split("@")[1];
  return `${jidUser(value)}@${server}`;
}

function toLidJid(value) {
  const text = safeDecode(value);
  if (!text) return null;
  if (isLidJid(text)) return toBareJid(text);
  if (text.includes("@")) return null;
  return `${jidUser(text)}${LID_SUFFIX}`;
}

function toPnJid(value) {
  const text = safeDecode(value);
  if (!text) return null;

  if (isPnJid(text)) return toBareJid(text);
  if (text.endsWith("@c.us")) return `${jidUser(text)}${PN_SUFFIX}`;
  if (text.includes("@")) return null;

  const phone = text.replace(/[^0-9]/g, "");
  return phone ? `${phone}${PN_SUFFIX}` : null;
}

function formatSendJid(value) {
  const text = safeDecode(value);
  if (!text) return "";

  if (text.includes("@")) {
    if (isPnJid(text) || isLidJid(text) || isGroupJid(text)) return toBareJid(text);
    return text;
  }

  const phone = text.replace(/[^0-9]/g, "");
  return phone ? `${phone}${PN_SUFFIX}` : text;
}

function getAccountStore(accountId) {
  if (!lidMappingsByAccount.has(accountId)) {
    lidMappingsByAccount.set(accountId, {
      lidToPn: new Map(),
      pnToLid: new Map(),
    });
  }

  return lidMappingsByAccount.get(accountId);
}

function rememberLidMapping(accountId, lid, pn, source = "unknown") {
  const lidJid = toLidJid(lid);
  const pnJid = toPnJid(pn);

  if (!accountId || !lidJid || !pnJid) return null;

  const store = getAccountStore(accountId);
  const previous = store.lidToPn.get(lidJid);
  const changed = previous !== pnJid;

  store.lidToPn.set(lidJid, pnJid);
  store.lidToPn.set(jidUser(lidJid), pnJid);
  store.pnToLid.set(pnJid, lidJid);
  store.pnToLid.set(jidUser(pnJid), lidJid);

  return { lidJid, pnJid, source, changed };
}

function rememberContactLidMapping(accountId, contact, source = "contacts.upsert") {
  if (!contact) return null;

  const lid = contact.lid || (isLidJid(contact.id) ? contact.id : null);
  const pn = contact.jid || (isPnJid(contact.id) ? contact.id : null);

  return rememberLidMapping(accountId, lid, pn, source);
}

function rememberMessageKeyLidMappings(accountId, key, source = "messages.upsert") {
  if (!key) return [];

  const mappings = [];
  const pairs = [
    [key.senderLid || (isLidJid(key.remoteJid) ? key.remoteJid : null), key.senderPn],
    [key.participantLid || (isLidJid(key.participant) ? key.participant : null), key.participantPn],
  ];

  for (const [lid, pn] of pairs) {
    const mapping = rememberLidMapping(accountId, lid, pn, source);
    if (mapping) mappings.push(mapping);
  }

  return mappings;
}

function resolveLidToPn(accountId, lid) {
  const store = lidMappingsByAccount.get(accountId);
  if (!store) return null;

  const lidJid = toLidJid(lid);
  const bare = jidUser(lid);

  return (lidJid && store.lidToPn.get(lidJid)) || store.lidToPn.get(bare) || null;
}

function resolveSendRecipient(accountId, recipient) {
  const raw = safeDecode(recipient);
  const inputJid = raw.includes("@") ? formatSendJid(raw) : null;
  const resolvedPn = isLidJid(raw) || !raw.includes("@") ? resolveLidToPn(accountId, raw) : null;

  if (resolvedPn) {
    return {
      deliveryJid: resolvedPn,
      chatId: inputJid || toLidJid(raw) || resolvedPn,
      contactNumber: jidUser(resolvedPn),
      originalJid: inputJid || toLidJid(raw),
      resolvedFromLid: true,
    };
  }

  const deliveryJid = formatSendJid(raw);

  return {
    deliveryJid,
    chatId: inputJid || deliveryJid,
    contactNumber: jidUser(deliveryJid),
    originalJid: inputJid || deliveryJid,
    resolvedFromLid: false,
  };
}

function clearLidMappings(accountId) {
  lidMappingsByAccount.delete(accountId);
}

module.exports = {
  clearLidMappings,
  formatSendJid,
  isLidJid,
  isPnJid,
  jidUser,
  rememberContactLidMapping,
  rememberLidMapping,
  rememberMessageKeyLidMappings,
  resolveLidToPn,
  resolveSendRecipient,
};
