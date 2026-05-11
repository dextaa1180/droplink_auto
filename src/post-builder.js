'use strict';

const DEFAULT_TIKTOK_NOTE = 'Yang dari tiktok gabung channel dulu atau salin aja terus buka di browser kalian masing masing, kalau langsung kalian buka dari tiktok gak bakal bisa.';

function createPostDraft(userId, chatId, initial = {}) {
  const now = new Date().toISOString();
  return {
    userId: String(userId || ''),
    chatId: String(chatId),
    step: initial.contentLink ? 'description' : 'description',
    description: '',
    previewLink: '',
    contentLink: initial.contentLink || '',
    shopLink: initial.shopLink || '',
    micrositeLink: initial.micrositeLink || '',
    createdAt: now,
    updatedAt: now
  };
}

function setDraftField(draft, field, value) {
  return {
    ...draft,
    [field]: String(value || '').trim(),
    updatedAt: new Date().toISOString()
  };
}

function setDraftStep(draft, step) {
  return {
    ...draft,
    step,
    updatedAt: new Date().toISOString()
  };
}

function buildPostText(draft, options = {}) {
  const date = formatLocalDate(options.now || new Date(), options.timeZone || 'Asia/Jakarta');
  const lines = [
    `📌 ASUPAN (${date})`,
    '',
    draft.description || '-'
  ];

  if (draft.previewLink) {
    lines.push(
      '',
      'Preview:',
      `➡️ ${draft.previewLink}`
    );
  }

  lines.push(
    '',
    'Link:',
    `➡️ ${draft.contentLink || '-'}`,
    `❗️ ${DEFAULT_TIKTOK_NOTE}`
  );

  if (draft.shopLink) {
    lines.push(
      '',
      'KUNJUNGI ETALASE TUNA 🛍',
      `➡️ ${draft.shopLink}`
    );
  }

  if (draft.micrositeLink) {
    lines.push(
      '',
      'KONTEN LAIN ✅',
      `➡️ ${draft.micrositeLink}`
    );
  }

  lines.push('', 'Thank you | Terima Kasih 🥰');

  return lines.join('\n');
}

function formatLocalDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}/${values.month}/${values.year}`;
}

module.exports = {
  buildPostText,
  createPostDraft,
  setDraftField,
  setDraftStep
};
