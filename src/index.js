'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildPostText, createPostDraft, setDraftField, setDraftStep } = require('./post-builder');
const { createTelegraphAccount, createTelegraphPreviewPage, uploadImageToTelegraph } = require('./telegraph-preview');
const { convertTeraboxShare } = require('./terabox-converter');
const { DEFAULT_LOGIN_URL, loginWithQrCode } = require('./terabox-login');

loadEnvFile(path.join(process.cwd(), '.env'));

const config = readConfig();
const telegramBaseUrl = `https://api.telegram.org/bot${config.telegramBotToken}`;
const droplinkHost = safeHost(config.droplinkBaseUrl);
const chatModes = new Map();
const teraboxSessions = loadSessionStore(config.sessionStorePath);
let telegraphAccount = loadTelegraphAccount(config.telegraphAccountStorePath);
const postChannels = loadChannelStore(config.postChannelStorePath);
const postShops = loadLinkStore(config.postShopStorePath, 'shops');
const postMicrosites = loadLinkStore(config.postMicrositeStorePath, 'microsites');
const activeTeraboxLogins = new Map();
const postDrafts = new Map();
const postActionLinks = new Map();
const previewDrafts = new Map();

const MODES = {
  SHORTEN: 'shorten',
  TERABOX_PRO: 'terabox_pro',
  TERABOX_CONVERT: 'terabox_convert',
  POST_BUILDER: 'post_builder'
};

const MENU_BUTTONS = {
  BUAT_POST: 'Buat Post',
  BUAT_PREVIEW: 'Buat Preview',
  SHORTEN: 'Shorten Link',
  TERABOX_PRO: 'TeraBox Pro',
  TERABOX_CONVERT: 'Convert TeraBox',
  TERABOX_DASHBOARD: 'Dashboard TeraBox',
  TERABOX_LOGIN: 'Login TeraBox',
  TERABOX_CONNECT: 'Hubungkan TeraBox',
  TERABOX_STATUS: 'Status Session',
  TERABOX_DISCONNECT: 'Putus Session',
  POST_CANCEL: 'Batal Post',
  POST_SKIP_PREVIEW: 'Lewati Preview',
  POST_SKIP_SHOP: 'Lewati Shop',
  POST_SKIP_MICROSITE: 'Lewati Microsite',
  POST_SEND: 'Kirim ke Channel',
  POST_EDIT: 'Edit Post',
  POST_EDIT_DESCRIPTION: 'Edit Deskripsi',
  POST_EDIT_PREVIEW: 'Edit Preview',
  POST_EDIT_CONTENT: 'Edit Link Konten',
  POST_EDIT_SHOP: 'Edit Shop',
  POST_EDIT_MICROSITE: 'Edit Microsite',
  POST_BACK_REVIEW: 'Kembali Preview',
  PREVIEW_DONE: 'Selesai Preview',
  PREVIEW_CANCEL: 'Batal Preview',
  HELP: 'Bantuan'
};

const TERABOX_HOSTS = new Set([
  '1024terabox.com',
  'terabox.com',
  'teraboxapp.com',
  'teraboxlink.com',
  'freeterabox.com',
  '4funbox.com',
  'mirrobox.com',
  'tibibox.com'
]);

let updateOffset = 0;
let isStopping = false;

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});

async function main() {
  console.log('Tuna Droplink Telegram Bot is running.');
  console.log(`Droplink base URL: ${config.droplinkBaseUrl}`);

  while (!isStopping) {
    try {
      const updates = await telegram('getUpdates', {
        offset: updateOffset,
        timeout: 50,
        allowed_updates: ['message', 'channel_post', 'callback_query']
      }, 65000);

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      if (!isStopping) {
        console.error('[polling]', error.message);
        await sleep(3000);
      }
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message || update.channel_post;
  if (!message) {
    return;
  }

  const chatId = message.chat.id;
  const userId = message.from && message.from.id;
  const chatIdString = String(chatId);

  if (!isAllowedTarget(userId, chatIdString)) {
    await reply(chatId, message.message_id, 'Maaf, bot ini sedang dibuat privat.');
    return;
  }

  const text = getMessageText(message);
  if (previewDrafts.has(getPreviewDraftKey(message)) && hasPreviewMedia(message)) {
    await handlePreviewMediaMessage(message);
    return;
  }

  if (!text) {
    return;
  }

  const command = parseCommand(text);
  if (command) {
    await handleCommand(message, command);
    return;
  }

  if (previewDrafts.has(getPreviewDraftKey(message))) {
    await handlePreviewTextMessage(message, text);
    return;
  }

  if (postDrafts.has(getPostDraftKey(message))) {
    await handlePostBuilderMessage(message, text);
    return;
  }

  const menuAction = parseMenuButton(text);
  if (menuAction) {
    await handleMenuAction(message, menuAction);
    return;
  }

  const mode = chatModes.get(chatIdString);
  const teraboxUrls = uniqueUrls(extractUrls(text).filter(isTeraboxUrl));
  if (mode === MODES.TERABOX_PRO) {
    if (teraboxUrls.length === 0) {
      await reply(chatId, message.message_id, 'Kirim link TeraBox, contoh: https://1024terabox.com/s/xxxxx');
      return;
    }

    await reshareTeraboxAndReply(message, teraboxUrls);
    return;
  }

  if (mode === MODES.TERABOX_CONVERT) {
    if (teraboxUrls.length === 0) {
      await reply(chatId, message.message_id, 'Kirim link TeraBox yang mau disimpan ulang ke akun dan dibuat share link baru.');
      return;
    }

    await convertTeraboxAndReply(message, teraboxUrls);
    return;
  }

  const urls = uniqueUrls(extractUrls(text).filter((url) => {
    if (isDroplinkUrl(url)) {
      return false;
    }

    return mode === MODES.SHORTEN || !isTeraboxUrl(url);
  }));
  if (urls.length === 0) {
    return;
  }

  await shortenAndReply(message, urls);
}

async function handleCommand(message, command) {
  const chatId = message.chat.id;

  if (command.name === 'start' || command.name === 'menu') {
    postDrafts.delete(getPostDraftKey(message));
    chatModes.delete(String(chatId));
    await sendMenu(chatId, message.message_id);
    return;
  }

  if (command.name === 'batal' || command.name === 'cancel') {
    if (postDrafts.delete(getPostDraftKey(message))) {
      chatModes.delete(String(chatId));
      await reply(chatId, message.message_id, 'Draft post dibatalkan.', {
        reply_markup: menuKeyboard()
      });
      return;
    }
  }

  if (command.name === 'help') {
    await reply(chatId, message.message_id, helpText());
    return;
  }

  if (command.name === 'buatpost' || command.name === 'buat_post' || command.name === 'post') {
    await startManualPostBuilder(message);
    return;
  }

  if (command.name === 'preview' || command.name === 'buatpreview' || command.name === 'buat_preview') {
    await startTelegraphPreview(message);
    return;
  }

  if (command.name === 'addchannel' || command.name === 'add_channel') {
    await addPostChannel(message, command.body);
    return;
  }

  if (command.name === 'listchannel' || command.name === 'list_channel') {
    await listPostChannels(message);
    return;
  }

  if (command.name === 'deletechannel' || command.name === 'delete_channel' || command.name === 'delchannel') {
    await deletePostChannel(message, command.body);
    return;
  }

  if (command.name === 'renamechannel' || command.name === 'rename_channel' || command.name === 'updatechannel' || command.name === 'update_channel') {
    await renamePostChannel(message, command.body);
    return;
  }

  if (command.name === 'addshop' || command.name === 'add_shop') {
    await addPostLinkItem(message, command.body, 'shop');
    return;
  }

  if (command.name === 'listshop' || command.name === 'list_shop') {
    await listPostLinkItems(message, 'shop');
    return;
  }

  if (command.name === 'deleteshop' || command.name === 'delete_shop' || command.name === 'delshop') {
    await deletePostLinkItem(message, command.body, 'shop');
    return;
  }

  if (command.name === 'renameshop' || command.name === 'rename_shop' || command.name === 'updateshop' || command.name === 'update_shop') {
    await renamePostLinkItem(message, command.body, 'shop');
    return;
  }

  if (command.name === 'addmicrosite' || command.name === 'add_micro' || command.name === 'add_microsite') {
    await addPostLinkItem(message, command.body, 'microsite');
    return;
  }

  if (command.name === 'listmicrosite' || command.name === 'list_micro' || command.name === 'list_microsite') {
    await listPostLinkItems(message, 'microsite');
    return;
  }

  if (command.name === 'deletemicrosite' || command.name === 'delete_micro' || command.name === 'delete_microsite' || command.name === 'delmicrosite') {
    await deletePostLinkItem(message, command.body, 'microsite');
    return;
  }

  if (command.name === 'renamemicrosite' || command.name === 'rename_micro' || command.name === 'rename_microsite' || command.name === 'updatemicrosite' || command.name === 'update_micro' || command.name === 'update_microsite') {
    await renamePostLinkItem(message, command.body, 'microsite');
    return;
  }

  if (command.name === 'short') {
    const parsed = parseShortCommand(command.body);
    if (parsed.urls.length === 0) {
      await reply(chatId, message.message_id, 'Kirim: /short https://example.com atau /short https://example.com alias=nama-alias');
      return;
    }

    await shortenAndReply(message, parsed.urls, parsed.alias);
    return;
  }

  if (command.name === 'terabox_pro' || command.name === 'terabox') {
    const urls = uniqueUrls(extractUrls(command.body).filter(isTeraboxUrl));
    if (urls.length === 0) {
      chatModes.set(String(chatId), MODES.TERABOX_PRO);
      await reply(chatId, message.message_id, 'Mode TeraBox Pro aktif. Kirim link TeraBox yang ingin diproses.');
      return;
    }

    await reshareTeraboxAndReply(message, urls);
    return;
  }

  if (command.name === 'convert_terabox' || command.name === 'terabox_convert' || command.name === 'convert' || command.name === 'pindah') {
    const urls = uniqueUrls(extractUrls(command.body).filter(isTeraboxUrl));
    if (urls.length === 0) {
      chatModes.set(String(chatId), MODES.TERABOX_CONVERT);
      await reply(chatId, message.message_id, 'Mode Convert TeraBox aktif. Kirim link TeraBox yang mau disimpan ulang dan dibuat share link baru.');
      return;
    }

    await convertTeraboxAndReply(message, urls);
    return;
  }

  if (command.name === 'terabox_dashboard' || command.name === 'dashboard_terabox') {
    await sendTeraboxDashboard(message);
    return;
  }

  if (command.name === 'terabox_connect' || command.name === 'hubungkan_terabox') {
    await startTeraboxSession(message);
    return;
  }

  if (command.name === 'terabox_login' || command.name === 'login_terabox') {
    await startTeraboxSession(message);
    return;
  }

  if (command.name === 'terabox_status' || command.name === 'status_terabox') {
    await showTeraboxSessionStatus(message);
    return;
  }

  if (command.name === 'terabox_logout' || command.name === 'putus_terabox') {
    await disconnectTeraboxSession(message);
    return;
  }

  await reply(chatId, message.message_id, 'Command tidak dikenal. Pakai /help untuk melihat contoh penggunaan.');
}

async function handleMenuAction(message, action) {
  const chatId = message.chat.id;

  if (action === MODES.POST_BUILDER) {
    await startManualPostBuilder(message);
    return;
  }

  if (action === 'preview_builder') {
    await startTelegraphPreview(message);
    return;
  }

  if (action === MODES.SHORTEN) {
    chatModes.set(String(chatId), MODES.SHORTEN);
    await reply(chatId, message.message_id, 'Mode Shorten aktif. Kirim link yang ingin dibuat shortlink Droplink.');
    return;
  }

  if (action === MODES.TERABOX_PRO) {
    chatModes.set(String(chatId), MODES.TERABOX_PRO);
    await reply(chatId, message.message_id, 'Mode TeraBox Pro aktif. Kirim link TeraBox untuk mengambil metadata, download link, dan stream link dari API.');
    return;
  }

  if (action === MODES.TERABOX_CONVERT) {
    chatModes.set(String(chatId), MODES.TERABOX_CONVERT);
    await reply(chatId, message.message_id, 'Mode Convert TeraBox aktif. Kirim link TeraBox untuk save ke akun, lalu bot buat share link baru.');
    return;
  }

  if (action === 'terabox_dashboard') {
    await sendTeraboxDashboard(message);
    return;
  }

  if (action === 'terabox_connect') {
    await startTeraboxSession(message);
    return;
  }

  if (action === 'terabox_login') {
    await startTeraboxSession(message);
    return;
  }

  if (action === 'terabox_status') {
    await showTeraboxSessionStatus(message);
    return;
  }

  if (action === 'terabox_disconnect') {
    await disconnectTeraboxSession(message);
    return;
  }

  await reply(chatId, message.message_id, helpText(), {
    reply_markup: menuKeyboard()
  });
}

async function startManualPostBuilder(message, initial = {}) {
  const chatId = message.chat.id;

  if (!message.from || !message.from.id) {
    await reply(chatId, message.message_id, 'Fitur buat post hanya bisa dipakai dari chat user.');
    return;
  }

  const draft = createPostDraft(message.from.id, chatId, initial);
  postDrafts.set(getPostDraftKey(message), draft);
  chatModes.set(String(chatId), MODES.POST_BUILDER);

  const intro = initial.contentLink ? [
    'Mode Buat Post aktif.',
    '',
    `Link konten sudah terisi: ${initial.contentLink}`,
    '',
    'Kirim deskripsi konten untuk postingan ini.'
  ] : initial.previewLink ? [
    'Mode Buat Post aktif.',
    '',
    `Link preview sudah terisi: ${initial.previewLink}`,
    '',
    'Kirim deskripsi konten untuk postingan ini.'
  ] : [
    'Mode Buat Post aktif.',
    '',
    'Kirim deskripsi konten untuk postingan ini.'
  ];

  await reply(chatId, message.message_id, intro.join('\n'), {
    reply_markup: postBuilderKeyboard('description')
  });
}

async function handlePostBuilderMessage(message, text) {
  const chatId = message.chat.id;
  const draftKey = getPostDraftKey(message);
  let draft = postDrafts.get(draftKey);

  if (!draft) {
    return;
  }

  if (isPostCancelText(text)) {
    postDrafts.delete(draftKey);
    chatModes.delete(String(chatId));
    await reply(chatId, message.message_id, 'Draft post dibatalkan.', {
      reply_markup: menuKeyboard()
    });
    return;
  }

  if (isPostBackReviewText(text)) {
    draft = clearDraftEdit(setDraftStep(draft, 'review'));
    postDrafts.set(draftKey, draft);
    await sendPostDraftReview(message, draft);
    return;
  }

  if (text.trim().toLowerCase() === MENU_BUTTONS.POST_EDIT.toLowerCase()) {
    draft = setDraftStep(draft, 'edit_select');
    postDrafts.set(draftKey, draft);
    await reply(chatId, message.message_id, 'Pilih bagian yang mau diedit.', {
      reply_markup: postBuilderKeyboard('edit_select')
    });
    return;
  }

  if (draft.step === 'edit_select') {
    await handlePostEditSelection(message, draft, text);
    return;
  }

  if (draft.step === 'description') {
    const description = text.trim();
    if (!description) {
      await reply(chatId, message.message_id, 'Deskripsi tidak boleh kosong. Kirim deskripsi konten.', {
        reply_markup: postBuilderKeyboard('description')
      });
      return;
    }

    draft = setDraftField(draft, 'description', description);
    if (draft.editing) {
      draft = clearDraftEdit(setDraftStep(draft, 'review'));
      postDrafts.set(draftKey, draft);
      await sendPostDraftReview(message, draft);
      return;
    }

    if (draft.previewLink) {
      const nextStep = draft.contentLink ? 'shop_link' : 'content_link';
      draft = setDraftStep(draft, nextStep);
      postDrafts.set(draftKey, draft);

      if (nextStep === 'shop_link') {
        await startPostLinkSelection(message, draft, 'shop');
        return;
      }

      await reply(chatId, message.message_id, 'Kirim link konten untuk postingan ini.', {
        reply_markup: postBuilderKeyboard('content_link')
      });
      return;
    }

    draft = setDraftStep(draft, 'preview_link');
    postDrafts.set(draftKey, draft);
    await reply(chatId, message.message_id, 'Kirim link preview. Untuk sekarang masih manual.', {
      reply_markup: postBuilderKeyboard('preview_link')
    });
    return;
  }

  if (draft.step === 'preview_link') {
    const previewLink = text.trim().toLowerCase() === MENU_BUTTONS.POST_SKIP_PREVIEW.toLowerCase() ? '' : firstUrlFromText(text);
    if (text.trim().toLowerCase() !== MENU_BUTTONS.POST_SKIP_PREVIEW.toLowerCase() && !previewLink) {
      await reply(chatId, message.message_id, 'Kirim link preview yang valid, atau pilih Lewati Preview.', {
        reply_markup: postBuilderKeyboard('preview_link')
      });
      return;
    }

    draft = setDraftField(draft, 'previewLink', previewLink);
    if (draft.editing) {
      draft = clearDraftEdit(setDraftStep(draft, 'review'));
      postDrafts.set(draftKey, draft);
      await sendPostDraftReview(message, draft);
      return;
    }

    const nextStep = draft.contentLink ? 'shop_link' : 'content_link';
    draft = setDraftStep(draft, nextStep);
    postDrafts.set(draftKey, draft);

    if (nextStep === 'shop_link') {
      await startPostLinkSelection(message, draft, 'shop');
      return;
    }

    await reply(chatId, message.message_id, 'Kirim link konten untuk postingan ini.', {
      reply_markup: postBuilderKeyboard('content_link')
    });
    return;
  }

  if (draft.step === 'content_link') {
    const contentLink = firstUrlFromText(text);
    if (!contentLink) {
      await reply(chatId, message.message_id, 'Kirim link konten yang valid.', {
        reply_markup: postBuilderKeyboard('content_link')
      });
      return;
    }

    draft = setDraftField(draft, 'contentLink', contentLink);
    if (draft.editing) {
      draft = clearDraftEdit(setDraftStep(draft, 'review'));
      postDrafts.set(draftKey, draft);
      await sendPostDraftReview(message, draft);
      return;
    }

    draft = setDraftStep(draft, 'shop_link');
    postDrafts.set(draftKey, draft);
    await startPostLinkSelection(message, draft, 'shop');
    return;
  }

  if (draft.step === 'shop_link') {
    if (text.trim().toLowerCase() === MENU_BUTTONS.POST_SKIP_SHOP.toLowerCase()) {
      draft = setDraftField(draft, 'shopLink', '');
      if (draft.editing) {
        draft = clearDraftEdit(setDraftStep(draft, 'review'));
        postDrafts.set(draftKey, draft);
        await sendPostDraftReview(message, draft);
        return;
      }

      draft = setDraftStep(draft, 'microsite_link');
      postDrafts.set(draftKey, draft);
      await startPostLinkSelection(message, draft, 'microsite');
      return;
    }

    const shop = findPostLinkItemByButtonText(text, 'shop');
    if (!shop) {
      await reply(chatId, message.message_id, 'Pilih shop dari tombol yang tersedia, atau pilih Lewati Shop.', {
        reply_markup: postBuilderKeyboard('shop_link')
      });
      return;
    }

    draft = setDraftField(draft, 'shopLink', shop.url);
    if (draft.editing) {
      draft = clearDraftEdit(setDraftStep(draft, 'review'));
      postDrafts.set(draftKey, draft);
      await sendPostDraftReview(message, draft);
      return;
    }

    draft = setDraftStep(draft, 'microsite_link');
    postDrafts.set(draftKey, draft);
    await startPostLinkSelection(message, draft, 'microsite');
    return;
  }

  if (draft.step === 'microsite_link') {
    if (text.trim().toLowerCase() === MENU_BUTTONS.POST_SKIP_MICROSITE.toLowerCase()) {
      draft = setDraftStep(setDraftField(draft, 'micrositeLink', ''), 'review');
      draft = clearDraftEdit(draft);
      postDrafts.set(draftKey, draft);
      await sendPostDraftReview(message, draft);
      return;
    }

    const microsite = findPostLinkItemByButtonText(text, 'microsite');
    if (!microsite) {
      await reply(chatId, message.message_id, 'Pilih microsite dari tombol yang tersedia, atau pilih Lewati Microsite.', {
        reply_markup: postBuilderKeyboard('microsite_link')
      });
      return;
    }

    draft = clearDraftEdit(setDraftStep(setDraftField(draft, 'micrositeLink', microsite.url), 'review'));
    postDrafts.set(draftKey, draft);
    await sendPostDraftReview(message, draft);
    return;
  }

  if (draft.step === 'review') {
    if (text.trim().toLowerCase() === MENU_BUTTONS.POST_SEND.toLowerCase()) {
      await startPostChannelSelection(message, draft);
      return;
    }

    await reply(chatId, message.message_id, 'Pilih Kirim ke Channel, Edit Post, atau Batal Post.', {
      reply_markup: postBuilderKeyboard('review')
    });
    return;
  }

  if (draft.step === 'channel_select') {
    const channel = findPostChannelByButtonText(text);
    if (!channel) {
      await reply(chatId, message.message_id, 'Pilih channel dari tombol yang tersedia.', {
        reply_markup: postChannelSelectKeyboard()
      });
      return;
    }

    draft = setDraftField(draft, 'channelId', channel.id);
    postDrafts.set(draftKey, draft);
    await publishPostDraft(message, draft, channel);
  }
}

async function handlePostEditSelection(message, draft, text) {
  const chatId = message.chat.id;
  const draftKey = getPostDraftKey(message);
  const normalized = text.trim().toLowerCase();

  if (normalized === MENU_BUTTONS.POST_EDIT_DESCRIPTION.toLowerCase()) {
    draft = setDraftEditStep(draft, 'description', 'description');
    postDrafts.set(draftKey, draft);
    await reply(chatId, message.message_id, 'Kirim deskripsi baru.', {
      reply_markup: postBuilderKeyboard('description', draft)
    });
    return;
  }

  if (normalized === MENU_BUTTONS.POST_EDIT_PREVIEW.toLowerCase()) {
    draft = setDraftEditStep(draft, 'preview_link', 'previewLink');
    postDrafts.set(draftKey, draft);
    await reply(chatId, message.message_id, 'Kirim link preview baru, atau pilih Lewati Preview.', {
      reply_markup: postBuilderKeyboard('preview_link', draft)
    });
    return;
  }

  if (normalized === MENU_BUTTONS.POST_EDIT_CONTENT.toLowerCase()) {
    draft = setDraftEditStep(draft, 'content_link', 'contentLink');
    postDrafts.set(draftKey, draft);
    await reply(chatId, message.message_id, 'Kirim link konten baru.', {
      reply_markup: postBuilderKeyboard('content_link', draft)
    });
    return;
  }

  if (normalized === MENU_BUTTONS.POST_EDIT_SHOP.toLowerCase()) {
    draft = setDraftEditStep(draft, 'shop_link', 'shopLink');
    postDrafts.set(draftKey, draft);
    await startPostLinkSelection(message, draft, 'shop');
    return;
  }

  if (normalized === MENU_BUTTONS.POST_EDIT_MICROSITE.toLowerCase()) {
    draft = setDraftEditStep(draft, 'microsite_link', 'micrositeLink');
    postDrafts.set(draftKey, draft);
    await startPostLinkSelection(message, draft, 'microsite');
    return;
  }

  await reply(chatId, message.message_id, 'Pilih bagian yang mau diedit dari tombol.', {
    reply_markup: postBuilderKeyboard('edit_select')
  });
}

async function startTelegraphPreview(message) {
  if (!message.from || !message.from.id) {
    await reply(message.chat.id, message.message_id, 'Fitur preview hanya bisa dipakai dari chat user.');
    return;
  }

  const draft = {
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    images: [],
    mediaGroups: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  previewDrafts.set(getPreviewDraftKey(message), draft);

  await reply(message.chat.id, message.message_id, [
    'Mode Buat Preview aktif.',
    '',
    'Kirim foto satu per satu atau sebagai album Telegram.',
    'Setelah selesai, pilih Selesai Preview.'
  ].join('\n'), {
    reply_markup: previewKeyboard()
  });
}

async function handlePreviewMediaMessage(message) {
  const draftKey = getPreviewDraftKey(message);
  const draft = previewDrafts.get(draftKey);
  const image = getPreviewImageFromMessage(message);

  if (!image) {
    await reply(message.chat.id, message.message_id, 'Kirim foto atau dokumen gambar untuk preview.', {
      reply_markup: previewKeyboard()
    });
    return;
  }

  if (draft.images.length >= config.telegraphPreviewMaxImages) {
    await reply(message.chat.id, message.message_id, `Batas preview ${config.telegraphPreviewMaxImages} gambar. Pilih Selesai Preview atau Batal Preview.`, {
      reply_markup: previewKeyboard()
    });
    return;
  }

  draft.images.push(image);
  draft.updatedAt = new Date().toISOString();
  previewDrafts.set(draftKey, draft);

  if (message.media_group_id) {
    if (!draft.mediaGroups.includes(message.media_group_id)) {
      draft.mediaGroups.push(message.media_group_id);
      await reply(message.chat.id, message.message_id, 'Album diterima. Setelah semua foto terkirim, pilih Selesai Preview.', {
        reply_markup: previewKeyboard()
      });
    }
    return;
  }

  await reply(message.chat.id, message.message_id, `Foto diterima. Total: ${draft.images.length}.`, {
    reply_markup: previewKeyboard()
  });
}

async function handlePreviewTextMessage(message, text) {
  const normalized = text.trim().toLowerCase();
  if (normalized === MENU_BUTTONS.PREVIEW_CANCEL.toLowerCase() || normalized === '/batal' || normalized === '/cancel') {
    previewDrafts.delete(getPreviewDraftKey(message));
    await reply(message.chat.id, message.message_id, 'Draft preview dibatalkan.', {
      reply_markup: menuKeyboard()
    });
    return;
  }

  if (normalized === MENU_BUTTONS.PREVIEW_DONE.toLowerCase()) {
    await finishTelegraphPreview(message);
    return;
  }

  await reply(message.chat.id, message.message_id, 'Kirim foto lagi, pilih Selesai Preview, atau Batal Preview.', {
    reply_markup: previewKeyboard()
  });
}

async function finishTelegraphPreview(message) {
  const draftKey = getPreviewDraftKey(message);
  const draft = previewDrafts.get(draftKey);
  if (!draft || draft.images.length === 0) {
    await reply(message.chat.id, message.message_id, 'Belum ada foto. Kirim foto dulu untuk dibuat preview.', {
      reply_markup: previewKeyboard()
    });
    return;
  }

  await telegram('sendChatAction', {
    chat_id: message.chat.id,
    action: 'upload_photo'
  });

  try {
    const account = await ensureTelegraphAccount();
    const imageUrls = [];

    for (const [index, image] of draft.images.entries()) {
      const buffer = await downloadTelegramFileBuffer(image.fileId);
      const imageUrl = await uploadImageToTelegraph(buffer, image.filename || `preview-${index + 1}.jpg`);
      imageUrls.push(imageUrl);
    }

    const page = await createTelegraphPreviewPage({
      accessToken: account.access_token,
      title: createPreviewTitle(),
      authorName: config.telegraphAuthorName,
      authorUrl: config.telegraphAuthorUrl,
      imageUrls
    });

    previewDrafts.delete(draftKey);
    await reply(message.chat.id, message.message_id, [
      '✅ Preview berhasil dibuat',
      `🔗 ${page.url}`,
      '',
      `Total foto: ${imageUrls.length}`
    ].join('\n'), {
      reply_markup: postFromPreviewKeyboard(page.url)
    });
  } catch (error) {
    await reply(message.chat.id, message.message_id, `Gagal membuat preview: ${error.message}`, {
      reply_markup: previewKeyboard()
    });
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || '';
  const message = callbackQuery.message;
  const userId = callbackQuery.from && callbackQuery.from.id;
  const chatId = message && message.chat && message.chat.id;

  if (!message || !chatId) {
    await answerCallbackQuery(callbackQuery.id, 'Pesan tombol tidak ditemukan.');
    return;
  }

  if (!isAllowedTarget(userId, String(chatId))) {
    await answerCallbackQuery(callbackQuery.id, 'Bot ini privat.', true);
    return;
  }

  if (data.startsWith('post_from_link:')) {
    const token = data.slice('post_from_link:'.length);
    const contentLink = takePostActionLink(token);

    if (!contentLink) {
      await answerCallbackQuery(callbackQuery.id, 'Tombol sudah expired. Jalankan converter lagi.', true);
      return;
    }

    await answerCallbackQuery(callbackQuery.id, 'Link konten masuk ke draft post.');
    await startManualPostBuilder({
      ...message,
      from: callbackQuery.from
    }, {
      contentLink
    });
    return;
  }

  if (data.startsWith('post_from_preview:')) {
    const token = data.slice('post_from_preview:'.length);
    const previewLink = takePostActionLink(token);

    if (!previewLink) {
      await answerCallbackQuery(callbackQuery.id, 'Tombol sudah expired. Buat preview lagi.', true);
      return;
    }

    await answerCallbackQuery(callbackQuery.id, 'Link preview masuk ke draft post.');
    await startManualPostBuilder({
      ...message,
      from: callbackQuery.from
    }, {
      previewLink
    });
    return;
  }

  await answerCallbackQuery(callbackQuery.id, 'Aksi tombol tidak dikenal.');
}

async function sendPostDraftReview(message, draft) {
  const postText = buildPostText(draft, {
    timeZone: config.postTimeZone
  });

  await reply(message.chat.id, message.message_id, [
    'Preview post:',
    '',
    postText
  ].join('\n'), {
    reply_markup: postBuilderKeyboard('review')
  });
}

async function publishPostDraft(message, draft, channel = resolveSinglePostChannel()) {
  const chatId = message.chat.id;
  const draftKey = getPostDraftKey(message);
  if (!channel || !channel.id) {
    await reply(chatId, message.message_id, 'Belum ada channel tujuan. Tambahkan dulu dengan /addchannel.', {
      reply_markup: postBuilderKeyboard('review')
    });
    return;
  }

  const postText = buildPostText(draft, {
    timeZone: config.postTimeZone
  });

  await sendMessage(channel.id, postText);
  postDrafts.delete(draftKey);
  chatModes.delete(String(chatId));

  await reply(chatId, message.message_id, `Post sudah terkirim ke ${channel.name}.`, {
    reply_markup: menuKeyboard()
  });
}

async function startPostChannelSelection(message, draft) {
  const chatId = message.chat.id;
  const channels = getPostChannels();

  if (channels.length === 0) {
    await reply(chatId, message.message_id, [
      'Belum ada channel di database.',
      '',
      'Tambahkan dulu dengan:',
      '/addchannel -100xxxxxxxxxx Nama Channel'
    ].join('\n'), {
      reply_markup: postBuilderKeyboard('review')
    });
    return;
  }

  if (channels.length === 1) {
    await publishPostDraft(message, draft, channels[0]);
    return;
  }

  const draftKey = getPostDraftKey(message);
  postDrafts.set(draftKey, setDraftStep(draft, 'channel_select'));
  await reply(chatId, message.message_id, 'Pilih channel tujuan:', {
    reply_markup: postChannelSelectKeyboard()
  });
}

async function addPostChannel(message, body) {
  const parsed = parseAddChannelBody(body);
  if (!parsed) {
    await reply(message.chat.id, message.message_id, [
      'Format:',
      '/addchannel -100xxxxxxxxxx Nama Channel',
      '/addchannel @usernamechannel Nama Channel'
    ].join('\n'));
    return;
  }

  try {
    const validated = await validateBotChannelAdmin(parsed.id);
    const channelName = parsed.name === parsed.id ? (validated.title || parsed.name) : parsed.name;
    const channel = upsertPostChannel(parsed.id, channelName);
    await reply(message.chat.id, message.message_id, [
      'Channel tersimpan:',
      formatPostChannel(channel),
      '',
      `Status bot: ${validated.status}`
    ].join('\n'));
  } catch (error) {
    await reply(message.chat.id, message.message_id, [
      'Channel belum disimpan.',
      '',
      error.message,
      '',
      'Pastikan bot sudah ditambahkan sebagai admin channel, lalu ulangi /addchannel.'
    ].join('\n'));
  }
}

async function listPostChannels(message) {
  const channels = getPostChannels();
  if (channels.length === 0) {
    await reply(message.chat.id, message.message_id, 'Belum ada channel tersimpan. Pakai /addchannel untuk menambahkan.');
    return;
  }

  await reply(message.chat.id, message.message_id, [
    'Daftar channel:',
    '',
    ...channels.map((channel, index) => `${index + 1}. ${formatPostChannel(channel)}`)
  ].join('\n'));
}

async function deletePostChannel(message, body) {
  const query = String(body || '').trim();
  if (!query) {
    await reply(message.chat.id, message.message_id, 'Format: /deletechannel <nomor|channel_id|@username>');
    return;
  }

  const removed = removePostChannel(query);
  if (!removed) {
    await reply(message.chat.id, message.message_id, 'Channel tidak ditemukan. Cek daftar dengan /listchannel.');
    return;
  }

  await reply(message.chat.id, message.message_id, `Channel dihapus:\n${formatPostChannel(removed)}`);
}

async function renamePostChannel(message, body) {
  const parsed = parseRenameBody(body);
  if (!parsed) {
    await reply(message.chat.id, message.message_id, 'Format: /renamechannel <nomor|channel_id|@username> Nama Baru');
    return;
  }

  const channel = renamePostChannelRecord(parsed.query, parsed.name);
  if (!channel) {
    await reply(message.chat.id, message.message_id, 'Channel tidak ditemukan. Cek daftar dengan /listchannel.');
    return;
  }

  await reply(message.chat.id, message.message_id, `Channel diperbarui:\n${formatPostChannel(channel)}`);
}

async function startPostLinkSelection(message, draft, type) {
  const chatId = message.chat.id;
  const items = getPostLinkItems(type);
  const step = type === 'shop' ? 'shop_link' : 'microsite_link';

  postDrafts.set(getPostDraftKey(message), setDraftStep(draft, step));
  if (items.length === 0) {
    await reply(chatId, message.message_id, [
      `Belum ada ${postLinkLabel(type)} di database.`,
      '',
      `Tambahkan dulu dengan ${postLinkAddCommand(type)}, atau pilih tombol Lewati.`
    ].join('\n'), {
      reply_markup: postBuilderKeyboard(step)
    });
    return;
  }

  await reply(chatId, message.message_id, `Pilih ${postLinkLabel(type)} untuk post ini:`, {
    reply_markup: postBuilderKeyboard(step)
  });
}

async function addPostLinkItem(message, body, type) {
  const parsed = parseAddLinkBody(body);
  if (!parsed) {
    await reply(message.chat.id, message.message_id, [
      'Format:',
      `${postLinkAddCommand(type)} https://example.com Nama Link`
    ].join('\n'));
    return;
  }

  const item = upsertPostLinkItem(type, parsed.url, parsed.name);
  await reply(message.chat.id, message.message_id, `${postLinkTitle(type)} tersimpan:\n${formatPostLinkItem(item)}`);
}

async function listPostLinkItems(message, type) {
  const items = getPostLinkItems(type);
  if (items.length === 0) {
    await reply(message.chat.id, message.message_id, `Belum ada ${postLinkLabel(type)} tersimpan. Pakai ${postLinkAddCommand(type)} untuk menambahkan.`);
    return;
  }

  await reply(message.chat.id, message.message_id, [
    `Daftar ${postLinkLabel(type)}:`,
    '',
    ...items.map((item, index) => `${index + 1}. ${formatPostLinkItem(item)}`)
  ].join('\n'));
}

async function deletePostLinkItem(message, body, type) {
  const query = String(body || '').trim();
  if (!query) {
    await reply(message.chat.id, message.message_id, `Format: ${postLinkDeleteCommand(type)} <nomor|url|nama>`);
    return;
  }

  const removed = removePostLinkItem(type, query);
  if (!removed) {
    await reply(message.chat.id, message.message_id, `${postLinkTitle(type)} tidak ditemukan. Cek daftar dengan ${postLinkListCommand(type)}.`);
    return;
  }

  await reply(message.chat.id, message.message_id, `${postLinkTitle(type)} dihapus:\n${formatPostLinkItem(removed)}`);
}

async function renamePostLinkItem(message, body, type) {
  const parsed = parseRenameBody(body);
  if (!parsed) {
    await reply(message.chat.id, message.message_id, `Format: ${postLinkRenameCommand(type)} <nomor|url|nama> Nama Baru`);
    return;
  }

  const item = renamePostLinkRecord(type, parsed.query, parsed.name);
  if (!item) {
    await reply(message.chat.id, message.message_id, `${postLinkTitle(type)} tidak ditemukan. Cek daftar dengan ${postLinkListCommand(type)}.`);
    return;
  }

  await reply(message.chat.id, message.message_id, `${postLinkTitle(type)} diperbarui:\n${formatPostLinkItem(item)}`);
}

async function shortenAndReply(message, urls, alias) {
  const chatId = message.chat.id;
  const limitedUrls = uniqueUrls(urls).slice(0, config.maxUrlsPerMessage);

  if (urls.length > limitedUrls.length) {
    await reply(chatId, message.message_id, `Saya proses ${limitedUrls.length} link pertama dulu.`);
  }

  await telegram('sendChatAction', {
    chat_id: chatId,
    action: 'typing'
  });

  const results = [];
  for (const longUrl of limitedUrls) {
    try {
      const shortUrl = await shortenWithDroplink(longUrl, limitedUrls.length === 1 ? alias : undefined);
      results.push({ longUrl, shortUrl });
    } catch (error) {
      results.push({ longUrl, error: error.message });
    }
  }

  await reply(chatId, message.message_id, formatResults(results), {
    reply_markup: postFromResultsKeyboard(results)
  });
}

async function reshareTeraboxAndReply(message, urls) {
  const chatId = message.chat.id;
  const limitedUrls = uniqueUrls(urls).slice(0, config.maxUrlsPerMessage);

  if (urls.length > limitedUrls.length) {
    await reply(chatId, message.message_id, `Saya proses ${limitedUrls.length} link TeraBox pertama dulu.`);
  }

  await telegram('sendChatAction', {
    chat_id: chatId,
    action: 'typing'
  });

  const results = [];
  for (const shareUrl of limitedUrls) {
    try {
      const output = await reshareTeraboxLink(shareUrl, message);
      results.push({ shareUrl, ...output });
    } catch (error) {
      results.push({ shareUrl, error: error.message });
    }
  }

  await reply(chatId, message.message_id, formatTeraboxResults(results));
}

async function convertTeraboxAndReply(message, urls) {
  const chatId = message.chat.id;
  const session = getMessageUserSession(message);

  if (!session || session.status !== 'connected' || session.authType !== 'ndus') {
    await reply(chatId, message.message_id, 'Session TeraBox belum siap. Buka Dashboard TeraBox lalu pilih Login TeraBox dulu.', {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  const limitedUrls = uniqueUrls(urls).slice(0, config.maxUrlsPerMessage);
  if (urls.length > limitedUrls.length) {
    await reply(chatId, message.message_id, `Saya proses ${limitedUrls.length} link TeraBox pertama dulu.`);
  }

  await telegram('sendChatAction', {
    chat_id: chatId,
    action: 'typing'
  });

  const results = [];
  for (const shareUrl of limitedUrls) {
    try {
      const output = await convertTeraboxShare({
        ndus: session.sessionId,
        shareUrl,
        destinationRoot: config.teraboxConvertDestinationRoot,
        sharePassword: config.teraboxConvertSharePassword,
        sharePeriod: config.teraboxConvertSharePeriod,
        waitTimeoutMs: config.teraboxConvertWaitTimeoutMs
      });
      results.push({ shareUrl, ...output });
    } catch (error) {
      results.push({ shareUrl, error: error.message });
    }
  }

  await reply(chatId, message.message_id, formatTeraboxConvertResults(results), {
    reply_markup: postFromResultsKeyboard(results)
  });
}

async function reshareTeraboxLink(shareUrl, message) {
  if (!config.teraboxReshareApiUrl) {
    throw new Error('Fitur TeraBox Pro belum dikonfigurasi. Isi TERABOX_RESHARE_API_URL di .env.');
  }

  const session = getMessageUserSession(message);
  if (config.teraboxReshareRequireSession && !session) {
    throw new Error('Session TeraBox belum terhubung. Buka Dashboard TeraBox lalu pilih Hubungkan TeraBox.');
  }

  const headers = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    'content-type': 'application/json',
    'user-agent': 'TunaDroplinkTelegramBot/1.0'
  };

  if (config.teraboxReshareApiKey) {
    headers[config.teraboxReshareApiKeyHeader] = config.teraboxReshareApiKey;
  }

  const requestBody = {
    url: shareUrl
  };

  if (config.teraboxReshareRequireSession) {
    requestBody.sessionId = session ? session.sessionId : undefined;
    requestBody.telegramUserId = message.from ? String(message.from.id) : undefined;
    requestBody.telegramChatId = String(message.chat.id);
  }

  const response = await fetch(config.teraboxReshareApiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`TeraBox API HTTP ${response.status}: ${truncate(body)}`);
  }

  const payload = parseResponseBody(body);
  const apiStatus = typeof payload === 'object' && payload ? String(payload.status || '').toLowerCase() : '';
  if (apiStatus && apiStatus !== 'success') {
    throw new Error(payload.message || 'TeraBox API menolak request.');
  }

  const newShareUrl = findTeraboxShareUrl(payload, body);
  if (newShareUrl) {
    return { newShareUrl };
  }

  const detailsText = formatTeraboxApiPayload(payload);
  if (detailsText) {
    return { detailsText };
  }

  throw new Error('Response TeraBox API tidak berisi data yang dikenali.');
}

async function sendTeraboxDashboard(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  const session = getUserSession(message.from.id);
  await reply(message.chat.id, message.message_id, teraboxDashboardText(session), {
    reply_markup: teraboxDashboardKeyboard()
  });
}

async function startTeraboxSession(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  if (!config.teraboxSessionStartApiUrl) {
    await startTeraboxPuppeteerLogin(message);
    return;
  }

  await telegram('sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing'
  });

  try {
    const payload = await callTeraboxSessionApi(config.teraboxSessionStartApiUrl, {
      action: 'start',
      telegramUserId: String(message.from.id),
      telegramChatId: String(message.chat.id),
      username: message.from.username || '',
      firstName: message.from.first_name || '',
      lastName: message.from.last_name || ''
    });

    const session = saveSessionFromPayload(message, payload, 'pending');
    const text = formatTeraboxSessionStart(payload, session);
    const qrImageUrl = getPayloadString(payload, ['qrImageUrl', 'qr_image_url', 'qrUrl', 'qr_url']);

    if (qrImageUrl && isHttpUrl(qrImageUrl)) {
      await sendPhoto(message.chat.id, qrImageUrl, text, {
        reply_to_message_id: message.message_id,
        reply_markup: teraboxDashboardKeyboard()
      });
      return;
    }

    await reply(message.chat.id, message.message_id, text, {
      reply_markup: teraboxDashboardKeyboard()
    });
  } catch (error) {
    await reply(message.chat.id, message.message_id, `Gagal memulai session TeraBox: ${error.message}`, {
      reply_markup: teraboxDashboardKeyboard()
    });
  }
}

async function startTeraboxPuppeteerLogin(message) {
  if (!config.teraboxLoginPuppeteerEnabled) {
    await reply(message.chat.id, message.message_id, [
      'Login QR lokal belum aktif.',
      '',
      'Isi TERABOX_LOGIN_PUPPETEER_ENABLED=true atau pakai TERABOX_SESSION_START_API_URL jika login ditangani endpoint terpisah.'
    ].join('\n'), {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  const loginKey = String(message.from.id);
  if (activeTeraboxLogins.has(loginKey)) {
    await reply(message.chat.id, message.message_id, 'Login TeraBox sedang berjalan. Scan QR yang sudah dikirim, lalu tunggu status sukses.', {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  activeTeraboxLogins.set(loginKey, true);

  await reply(message.chat.id, message.message_id, [
    'Saya buka halaman login TeraBox dan menyiapkan QR.',
    'Scan QR dari aplikasi TeraBox, lalu konfirmasi login di HP.'
  ].join('\n'), {
    reply_markup: teraboxDashboardKeyboard()
  });

  runTeraboxPuppeteerLogin(message, loginKey).catch((error) => {
    console.error('[terabox-login]', error);
  });
}

async function runTeraboxPuppeteerLogin(message, loginKey) {
  try {
    const result = await loginWithQrCode({
      loginUrl: config.teraboxLoginUrl,
      headless: config.teraboxLoginHeadless,
      executablePath: config.teraboxLoginExecutablePath,
      loginTimeoutMs: config.teraboxLoginTimeoutMs,
      onQrImage: async (qrImage) => {
        await sendPhotoBuffer(message.chat.id, qrImage, [
          'QR Login TeraBox',
          '',
          'Scan QR ini dari aplikasi TeraBox. Setelah sukses, bot akan menyimpan session dan mengirim status.'
        ].join('\n'), {
          reply_to_message_id: message.message_id,
          reply_markup: teraboxDashboardKeyboard()
        });
      }
    });

    const session = savePuppeteerLoginSession(message, result);
    await sendMessage(message.chat.id, formatTeraboxSessionStatus(session, 'Login QR berhasil. Session TeraBox sudah tersimpan.'), {
      reply_markup: teraboxDashboardKeyboard()
    });
  } catch (error) {
    await sendMessage(message.chat.id, `Gagal login TeraBox via QR: ${error.message}`, {
      reply_markup: teraboxDashboardKeyboard()
    });
  } finally {
    activeTeraboxLogins.delete(loginKey);
  }
}

async function showTeraboxSessionStatus(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  const existing = getUserSession(message.from.id);
  if (!existing) {
    await reply(message.chat.id, message.message_id, 'Belum ada session TeraBox. Pilih Login TeraBox untuk mulai.', {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  if (!config.teraboxSessionStatusApiUrl) {
    await reply(message.chat.id, message.message_id, formatTeraboxSessionStatus(existing, 'Status ini dari data lokal karena TERABOX_SESSION_STATUS_API_URL belum diisi.'), {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  await telegram('sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing'
  });

  try {
    const payload = await callTeraboxSessionApi(config.teraboxSessionStatusApiUrl, {
      action: 'status',
      sessionId: existing.sessionId,
      telegramUserId: String(message.from.id),
      telegramChatId: String(message.chat.id)
    });

    const session = saveSessionFromPayload(message, payload, existing.status || 'pending');
    await reply(message.chat.id, message.message_id, formatTeraboxSessionStatus(session), {
      reply_markup: teraboxDashboardKeyboard()
    });
  } catch (error) {
    await reply(message.chat.id, message.message_id, `Gagal cek status session TeraBox: ${error.message}`, {
      reply_markup: teraboxDashboardKeyboard()
    });
  }
}

async function disconnectTeraboxSession(message) {
  if (!(await ensureTeraboxDashboardAccess(message))) {
    return;
  }

  const existing = getUserSession(message.from.id);
  if (!existing) {
    await reply(message.chat.id, message.message_id, 'Tidak ada session TeraBox yang tersimpan.', {
      reply_markup: teraboxDashboardKeyboard()
    });
    return;
  }

  if (config.teraboxSessionDisconnectApiUrl) {
    try {
      await callTeraboxSessionApi(config.teraboxSessionDisconnectApiUrl, {
        action: 'disconnect',
        sessionId: existing.sessionId,
        telegramUserId: String(message.from.id),
        telegramChatId: String(message.chat.id)
      });
    } catch (error) {
      await reply(message.chat.id, message.message_id, `Endpoint disconnect gagal: ${error.message}\nSession lokal belum dihapus.`, {
        reply_markup: teraboxDashboardKeyboard()
      });
      return;
    }
  }

  deleteUserSession(message.from.id);
  await reply(message.chat.id, message.message_id, 'Session TeraBox lokal sudah diputus.', {
    reply_markup: teraboxDashboardKeyboard()
  });
}

async function shortenWithDroplink(longUrl, alias) {
  const endpoint = new URL('/api', ensureTrailingSlash(config.droplinkBaseUrl));
  endpoint.searchParams.set('api', config.droplinkApiKey);
  endpoint.searchParams.set('url', longUrl);

  if (alias) {
    endpoint.searchParams.set('alias', alias);
  }

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      'user-agent': 'TunaDroplinkTelegramBot/1.0'
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Droplink HTTP ${response.status}: ${truncate(body)}`);
  }

  const payload = parseResponseBody(body);
  const apiStatus = typeof payload === 'object' && payload ? String(payload.status || '').toLowerCase() : '';

  if (apiStatus && apiStatus !== 'success') {
    throw new Error(payload.message || 'Droplink menolak request.');
  }

  const shortUrl = findShortUrl(payload, body);
  if (!shortUrl) {
    throw new Error('Response Droplink tidak berisi shortenedUrl.');
  }

  return shortUrl;
}

async function telegram(method, body, timeoutMs = config.requestTimeoutMs) {
  const response = await fetch(`${telegramBaseUrl}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    const description = payload && payload.description ? payload.description : `Telegram HTTP ${response.status}`;
    throw new Error(description);
  }

  return payload.result;
}

async function sendPhoto(chatId, photo, caption, options = {}) {
  return telegram('sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    ...options
  });
}

async function sendPhotoBuffer(chatId, photoBuffer, caption, options = {}) {
  return telegramForm('sendPhoto', {
    chat_id: String(chatId),
    photo: new Blob([photoBuffer], { type: 'image/png' }),
    caption,
    ...options
  }, {
    photo: 'terabox-login-qr.png'
  });
}

async function telegramForm(method, fields, filenames = {}) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (value instanceof Blob) {
      form.append(key, value, filenames[key] || `${key}.bin`);
    } else if (typeof value === 'object') {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }

  const response = await fetch(`${telegramBaseUrl}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    const description = payload && payload.description ? payload.description : `Telegram HTTP ${response.status}`;
    throw new Error(description);
  }

  return payload.result;
}

async function callTeraboxSessionApi(endpoint, body) {
  const headers = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    'content-type': 'application/json',
    'user-agent': 'TunaDroplinkTelegramBot/1.0'
  };

  if (config.teraboxSessionApiKey) {
    headers.authorization = `Bearer ${config.teraboxSessionApiKey}`;
    headers['x-api-key'] = config.teraboxSessionApiKey;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${truncate(responseBody)}`);
  }

  const payload = parseResponseBody(responseBody);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Response endpoint session harus JSON object.');
  }

  const apiStatus = String(payload.status || '').toLowerCase();
  if (apiStatus && !['success', 'pending', 'connected', 'authorized', 'disconnected'].includes(apiStatus)) {
    throw new Error(payload.message || 'Endpoint session menolak request.');
  }

  return payload;
}

async function reply(chatId, replyToMessageId, text, options = {}) {
  return sendMessage(chatId, text, {
    reply_to_message_id: replyToMessageId,
    ...options
  });
}

async function sendMessage(chatId, text, options = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options
  });
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return telegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

async function downloadTelegramFileBuffer(fileId) {
  const file = await telegram('getFile', {
    file_id: fileId
  });

  if (!file || !file.file_path) {
    throw new Error('Telegram tidak mengembalikan file_path.');
  }

  const response = await fetch(`${telegramFileBaseUrl()}/${file.file_path}`, {
    signal: AbortSignal.timeout(config.requestTimeoutMs * 4)
  });
  if (!response.ok) {
    throw new Error(`Download file Telegram HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function telegramFileBaseUrl() {
  return `https://api.telegram.org/file/bot${config.telegramBotToken}`;
}

async function getBotInfo() {
  if (!getBotInfo.promise) {
    getBotInfo.promise = telegram('getMe', {});
  }

  return getBotInfo.promise;
}

async function sendMenu(chatId, replyToMessageId) {
  return reply(chatId, replyToMessageId, menuText(), {
    reply_markup: menuKeyboard()
  });
}

function readConfig() {
  const telegramBotToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const droplinkApiKey = requireEnv('DROPLINK_API_KEY');
  const droplinkBaseUrl = cleanBaseUrl(process.env.DROPLINK_BASE_URL || 'https://droplink.co');

  return {
    telegramBotToken,
    droplinkApiKey,
    droplinkBaseUrl,
    allowedUserIds: parseIdSet(process.env.ALLOWED_USER_IDS || ''),
    allowedChatIds: parseIdSet(process.env.ALLOWED_CHAT_IDS || ''),
    postTimeZone: (process.env.POST_TIME_ZONE || 'Asia/Jakarta').trim(),
    postChannelStorePath: resolveWorkspacePath(process.env.POST_CHANNEL_STORE_FILE || path.join(process.env.DATA_DIR || 'data', 'post-channels.json')),
    postShopStorePath: resolveWorkspacePath(process.env.POST_SHOP_STORE_FILE || path.join(process.env.DATA_DIR || 'data', 'post-shops.json')),
    postMicrositeStorePath: resolveWorkspacePath(process.env.POST_MICROSITE_STORE_FILE || path.join(process.env.DATA_DIR || 'data', 'post-microsites.json')),
    telegraphAccessToken: (process.env.TELEGRAPH_ACCESS_TOKEN || '').trim(),
    telegraphShortName: (process.env.TELEGRAPH_SHORT_NAME || 'TunaPreview').trim(),
    telegraphAuthorName: (process.env.TELEGRAPH_AUTHOR_NAME || 'Tuna').trim(),
    telegraphAuthorUrl: optionalUrl(process.env.TELEGRAPH_AUTHOR_URL || '', 'TELEGRAPH_AUTHOR_URL'),
    telegraphAccountStorePath: resolveWorkspacePath(process.env.TELEGRAPH_ACCOUNT_STORE_FILE || path.join(process.env.DATA_DIR || 'data', 'telegraph-account.json')),
    telegraphPreviewMaxImages: parsePositiveInt(process.env.TELEGRAPH_PREVIEW_MAX_IMAGES, 20),
    teraboxDashboardUserIds: parseIdSet(process.env.TERABOX_DASHBOARD_USER_IDS || ''),
    maxUrlsPerMessage: parsePositiveInt(process.env.MAX_URLS_PER_MESSAGE, 5),
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
    teraboxReshareApiUrl: optionalUrl(process.env.TERABOX_RESHARE_API_URL || '', 'TERABOX_RESHARE_API_URL'),
    teraboxReshareApiKey: (process.env.TERABOX_RESHARE_API_KEY || '').trim(),
    teraboxReshareApiKeyHeader: cleanHeaderName(process.env.TERABOX_RESHARE_API_KEY_HEADER || 'xAPIverse-Key'),
    teraboxReshareRequireSession: parseBool(process.env.TERABOX_RESHARE_REQUIRE_SESSION, false),
    teraboxSessionStartApiUrl: optionalUrl(process.env.TERABOX_SESSION_START_API_URL || '', 'TERABOX_SESSION_START_API_URL'),
    teraboxSessionStatusApiUrl: optionalUrl(process.env.TERABOX_SESSION_STATUS_API_URL || '', 'TERABOX_SESSION_STATUS_API_URL'),
    teraboxSessionDisconnectApiUrl: optionalUrl(process.env.TERABOX_SESSION_DISCONNECT_API_URL || '', 'TERABOX_SESSION_DISCONNECT_API_URL'),
    teraboxSessionApiKey: (process.env.TERABOX_SESSION_API_KEY || '').trim(),
    teraboxLoginPuppeteerEnabled: parseBool(process.env.TERABOX_LOGIN_PUPPETEER_ENABLED, true),
    teraboxLoginUrl: optionalUrl(process.env.TERABOX_LOGIN_URL || DEFAULT_LOGIN_URL, 'TERABOX_LOGIN_URL'),
    teraboxLoginTimeoutMs: parsePositiveInt(process.env.TERABOX_LOGIN_TIMEOUT_MS, 180000),
    teraboxLoginHeadless: parseBool(process.env.TERABOX_LOGIN_HEADLESS, true),
    teraboxLoginExecutablePath: (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim(),
    teraboxConvertDestinationRoot: normalizeRemoteConfigDir(process.env.TERABOX_CONVERT_DESTINATION_ROOT || '/Tuna Bot'),
    teraboxConvertSharePassword: cleanTeraboxSharePassword(process.env.TERABOX_CONVERT_SHARE_PASSWORD || ''),
    teraboxConvertSharePeriod: parseNonNegativeInt(process.env.TERABOX_CONVERT_SHARE_PERIOD, 0),
    teraboxConvertWaitTimeoutMs: parsePositiveInt(process.env.TERABOX_CONVERT_WAIT_TIMEOUT_MS, 30000),
    sessionStorePath: resolveWorkspacePath(process.env.TERABOX_SESSION_STORE_FILE || path.join(process.env.DATA_DIR || 'data', 'terabox-sessions.json'))
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Environment variable ${name} wajib diisi.`);
  }

  return value.trim();
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getMessageText(message) {
  return message.text || message.caption || '';
}

function parseCommand(text) {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const body = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const match = head.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?$/i);

  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    body
  };
}

function parseShortCommand(body) {
  const urlMatches = extractUrlMatches(body).filter((item) => !isDroplinkUrl(item.url) && !isTeraboxUrl(item.url));
  const urls = uniqueUrls(urlMatches.map((item) => item.url));
  let alias = findAlias(body);

  if (!alias && urlMatches.length === 1) {
    const only = urlMatches[0];
    const afterUrl = body.slice(only.index + only.raw.length).trim();
    const aliasToken = afterUrl.split(/\s+/).find(Boolean);
    if (aliasToken && isSafeAlias(aliasToken)) {
      alias = aliasToken;
    }
  }

  return { urls, alias };
}

function parseMenuButton(text) {
  const normalized = text.trim().toLowerCase();

  if (normalized === MENU_BUTTONS.BUAT_POST.toLowerCase()) {
    return MODES.POST_BUILDER;
  }

  if (normalized === MENU_BUTTONS.BUAT_PREVIEW.toLowerCase()) {
    return 'preview_builder';
  }

  if (normalized === MENU_BUTTONS.SHORTEN.toLowerCase()) {
    return MODES.SHORTEN;
  }

  if (normalized === MENU_BUTTONS.TERABOX_PRO.toLowerCase()) {
    return MODES.TERABOX_PRO;
  }

  if (normalized === MENU_BUTTONS.TERABOX_CONVERT.toLowerCase()) {
    return MODES.TERABOX_CONVERT;
  }

  if (normalized === 'convert terabox' || normalized === 'pindah terabox') {
    return MODES.TERABOX_CONVERT;
  }

  if (normalized === MENU_BUTTONS.TERABOX_DASHBOARD.toLowerCase()) {
    return 'terabox_dashboard';
  }

  if (normalized === MENU_BUTTONS.TERABOX_CONNECT.toLowerCase()) {
    return 'terabox_connect';
  }

  if (normalized === MENU_BUTTONS.TERABOX_LOGIN.toLowerCase()) {
    return 'terabox_login';
  }

  if (normalized === MENU_BUTTONS.TERABOX_STATUS.toLowerCase()) {
    return 'terabox_status';
  }

  if (normalized === MENU_BUTTONS.TERABOX_DISCONNECT.toLowerCase()) {
    return 'terabox_disconnect';
  }

  if (normalized === MENU_BUTTONS.HELP.toLowerCase()) {
    return 'help';
  }

  return null;
}

function extractUrls(text) {
  return extractUrlMatches(text).map((item) => item.url);
}

function firstUrlFromText(text) {
  return extractUrls(text)[0] || '';
}

function extractUrlMatches(text) {
  const matches = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const raw = stripTrailingPunctuation(match[0]);
    const url = normalizeUrl(raw);
    if (url) {
      matches.push({
        raw,
        url,
        index: match.index
      });
    }
  }

  return matches;
}

function stripTrailingPunctuation(value) {
  return value.replace(/[)\].,!?;:]+$/g, '');
}

function normalizeUrl(value) {
  const withScheme = value.toLowerCase().startsWith('www.') ? `https://${value}` : value;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function uniqueUrls(urls) {
  return [...new Set(urls)];
}

function isDroplinkUrl(url) {
  if (!droplinkHost) {
    return false;
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return host === droplinkHost || host.endsWith(`.${droplinkHost}`);
  } catch {
    return false;
  }
}

function isTeraboxUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return TERABOX_HOSTS.has(host) || [...TERABOX_HOSTS].some((domain) => host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function findAlias(text) {
  const match = text.match(/(?:^|\s)(?:--)?alias=([a-z0-9_-]{1,50})(?=\s|$)/i);
  return match ? match[1] : undefined;
}

function isSafeAlias(value) {
  return /^[a-z0-9_-]{1,50}$/i.test(value);
}

function findShortUrl(payload, body) {
  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.shortenedUrl,
      payload.shortened_url,
      payload.shortUrl,
      payload.short_url,
      payload.url,
      payload.result
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isHttpUrl(candidate)) {
        return candidate;
      }
    }
  }

  if (typeof payload === 'string' && isHttpUrl(payload.trim())) {
    return payload.trim();
  }

  const baseHostPattern = escapeRegExp(droplinkHost || 'droplink.co');
  const match = body.match(new RegExp(`https?:\\/\\/(?:www\\.)?${baseHostPattern}\\/[^\\s"'<>]+`, 'i'));
  return match ? stripTrailingPunctuation(match[0]) : null;
}

function findTeraboxShareUrl(payload, body) {
  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.shareUrl,
      payload.share_url,
      payload.sharedUrl,
      payload.shared_url,
      payload.newShareUrl,
      payload.new_share_url,
      payload.url,
      payload.result
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isTeraboxUrl(candidate)) {
        return candidate;
      }
    }
  }

  if (typeof payload === 'string' && isTeraboxUrl(payload.trim())) {
    return payload.trim();
  }

  const match = body.match(/https?:\/\/[^\s"'<>]+/i);
  if (match && isTeraboxUrl(stripTrailingPunctuation(match[0]))) {
    return stripTrailingPunctuation(match[0]);
  }

  return null;
}

function parseResponseBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function saveSessionFromPayload(message, payload, fallbackStatus) {
  const existing = getUserSession(message.from.id) || {};
  const status = normalizeSessionStatus(getPayloadString(payload, ['status']) || fallbackStatus);
  const sessionId = getPayloadString(payload, ['sessionId', 'session_id', 'id']) || existing.sessionId;
  const now = new Date().toISOString();

  if (!sessionId) {
    throw new Error('Response endpoint session tidak berisi sessionId.');
  }

  const session = {
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    sessionId,
    status,
    accountName: getPayloadString(payload, ['accountName', 'account_name', 'displayName', 'display_name', 'name']) || existing.accountName || '',
    accountEmail: getPayloadString(payload, ['accountEmail', 'account_email', 'email']) || existing.accountEmail || '',
    createdAt: existing.createdAt || now,
    connectedAt: status === 'connected' ? (existing.connectedAt || now) : existing.connectedAt || '',
    expiresAt: getPayloadString(payload, ['expiresAt', 'expires_at', 'expireAt', 'expire_at']) || existing.expiresAt || '',
    updatedAt: now
  };

  setUserSession(message.from.id, session);
  return session;
}

function savePuppeteerLoginSession(message, result) {
  const existing = getUserSession(message.from.id) || {};
  const now = new Date().toISOString();

  if (!result || !result.ndus) {
    throw new Error('Puppeteer tidak menemukan cookie ndus setelah login.');
  }

  const session = {
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    sessionId: result.ndus,
    status: 'connected',
    authType: 'ndus',
    loginMethod: 'puppeteer_qr',
    pageUrl: result.pageUrl || '',
    accountName: existing.accountName || '',
    accountEmail: existing.accountEmail || '',
    createdAt: existing.createdAt || now,
    connectedAt: now,
    expiresAt: '',
    updatedAt: now
  };

  setUserSession(message.from.id, session);
  return session;
}

function normalizeSessionStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'authorized') {
    return 'connected';
  }

  if (['connected', 'pending', 'expired', 'disconnected', 'failed'].includes(normalized)) {
    return normalized;
  }

  return 'pending';
}

function formatResults(results) {
  if (results.length === 1 && results[0].shortUrl) {
    return results[0].shortUrl;
  }

  return results.map((result, index) => {
    if (result.shortUrl) {
      return `${index + 1}. ${result.longUrl}\n=> ${result.shortUrl}`;
    }

    return `${index + 1}. ${result.longUrl}\nGagal: ${result.error}`;
  }).join('\n\n');
}

function formatTeraboxResults(results) {
  if (results.length === 1 && results[0].newShareUrl) {
    return results[0].newShareUrl;
  }

  if (results.length === 1 && results[0].detailsText) {
    return results[0].detailsText;
  }

  return results.map((result, index) => {
    if (result.newShareUrl) {
      return `${index + 1}. ${result.shareUrl}\n=> ${result.newShareUrl}`;
    }

    if (result.detailsText) {
      return `${index + 1}. ${result.shareUrl}\n${result.detailsText}`;
    }

    return `${index + 1}. ${result.shareUrl}\nGagal: ${result.error}`;
  }).join('\n\n');
}

function formatTeraboxConvertResults(results) {
  if (results.length === 1 && results[0].newShareUrl) {
    return [
      '✅ Link berhasil dibuat',
      `🔗 ${results[0].newShareUrl}`,
      '',
      `File/folder: ${results[0].fileCount}`,
      `Lokasi akun: ${formatSharePaths(results[0])}`
    ].join('\n');
  }

  return results.map((result, index) => {
    if (result.newShareUrl) {
      return [
        `${index + 1}. ${result.shareUrl}`,
        `=> ${result.newShareUrl}`,
        `File/folder: ${result.fileCount}`,
        `Lokasi akun: ${formatSharePaths(result)}`
      ].join('\n');
    }

    return `${index + 1}. ${result.shareUrl}\nGagal: ${result.error}`;
  }).join('\n\n');
}

function formatSharePaths(result) {
  const paths = Array.isArray(result.sharePaths) && result.sharePaths.length > 0 ? result.sharePaths : [result.destinationDir];
  return paths.slice(0, 3).join(', ');
}

function formatTeraboxApiPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const files = Array.isArray(payload.list) ? payload.list : [];
  if (files.length === 0) {
    return '';
  }

  const lines = [
    `Status: ${payload.status || 'success'}`,
    `Total file: ${payload.total_files || files.length}`
  ];

  files.slice(0, config.maxUrlsPerMessage).forEach((file, index) => {
    lines.push('', `${index + 1}. ${file.name || 'Tanpa nama'}`);
    if (file.size_formatted) {
      lines.push(`Size: ${file.size_formatted}`);
    }

    if (file.type) {
      lines.push(`Type: ${file.type}`);
    }

    if (file.quality) {
      lines.push(`Quality: ${file.quality}`);
    }

    if (file.duration) {
      lines.push(`Duration: ${file.duration}`);
    }

    if (file.normal_dlink) {
      lines.push(`Download: ${file.normal_dlink}`);
    }

    if (file.zip_dlink) {
      lines.push(`Zip: ${file.zip_dlink}`);
    }

    const streamUrl = pickStreamUrl(file.fast_stream_url);
    if (streamUrl) {
      lines.push(`Stream: ${streamUrl}`);
    }
  });

  if (payload.folder_zip_dlink) {
    lines.push('', `Folder zip: ${payload.folder_zip_dlink}`);
  }

  return truncateTelegramMessage(lines.join('\n'));
}

function helpText() {
  return [
    'Kirim link biasa untuk dibuat shortlink Droplink.',
    'Kirim link TeraBox untuk diproses lewat mode TeraBox Pro.',
    'Pakai Convert TeraBox untuk save link ke akun lalu buat share link baru.',
    '',
    'Contoh:',
    '/short https://example.com',
    '/short https://example.com nama-alias',
    '/short https://example.com alias=nama-alias',
    '/buatpost',
    '/addchannel -100xxxxxxxxxx Nama Channel',
    '/listchannel',
    '/renamechannel 1 Nama Baru',
    '/deletechannel 1',
    '/addshop https://shop.example Etalase Tuna',
    '/listshop',
    '/renameshop 1 Nama Baru',
    '/deleteshop 1',
    '/addmicrosite https://site.example Konten Lain',
    '/listmicrosite',
    '/renamemicrosite 1 Nama Baru',
    '/deletemicrosite 1',
    '/preview',
    '/terabox_pro https://1024terabox.com/s/xxxxx',
    '/terabox https://1024terabox.com/s/xxxxx',
    '/convert_terabox https://1024terabox.com/s/xxxxx',
    '/pindah https://1024terabox.com/s/xxxxx',
    '/terabox_dashboard',
    '/terabox_login',
    '/terabox_connect',
    '/terabox_status',
    '/terabox_logout',
    '',
    'Catatan: TeraBox Pro memerlukan TERABOX_RESHARE_API_URL dan API key dari provider yang kamu pakai.'
  ].join('\n');
}

function menuText() {
  return [
    'Pilih menu:',
    '',
    `${MENU_BUTTONS.BUAT_POST} - susun postingan channel manual`,
    `${MENU_BUTTONS.BUAT_PREVIEW} - upload foto ke Telegra.ph preview`,
    `${MENU_BUTTONS.SHORTEN} - buat shortlink Droplink`,
    `${MENU_BUTTONS.TERABOX_PRO} - ambil metadata/download link TeraBox`,
    `${MENU_BUTTONS.TERABOX_CONVERT} - save ke akun dan buat share link baru`,
    `${MENU_BUTTONS.TERABOX_DASHBOARD} - kelola session pribadi`,
    `${MENU_BUTTONS.HELP} - lihat bantuan`
  ].join('\n');
}

function menuKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BUTTONS.BUAT_POST }, { text: MENU_BUTTONS.BUAT_PREVIEW }],
      [{ text: MENU_BUTTONS.SHORTEN }, { text: MENU_BUTTONS.TERABOX_PRO }],
      [{ text: MENU_BUTTONS.TERABOX_CONVERT }, { text: MENU_BUTTONS.TERABOX_DASHBOARD }],
      [{ text: MENU_BUTTONS.HELP }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Pilih menu atau kirim link'
  };
}

function previewKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BUTTONS.PREVIEW_DONE }],
      [{ text: MENU_BUTTONS.PREVIEW_CANCEL }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Kirim foto preview'
  };
}

function postBuilderKeyboard(step, draft = null) {
  if (step === 'preview_link') {
    return {
      keyboard: [
        [{ text: MENU_BUTTONS.POST_SKIP_PREVIEW }, { text: MENU_BUTTONS.POST_CANCEL }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Kirim link preview'
    };
  }

  if (step === 'shop_link') {
    const rows = getPostLinkItems('shop').map((item) => [{ text: postLinkButtonText(item, 'shop') }]);
    rows.push([{ text: MENU_BUTTONS.POST_SKIP_SHOP }, { text: MENU_BUTTONS.POST_CANCEL }]);
    return {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Pilih shop'
    };
  }

  if (step === 'microsite_link') {
    const rows = getPostLinkItems('microsite').map((item) => [{ text: postLinkButtonText(item, 'microsite') }]);
    rows.push([{ text: MENU_BUTTONS.POST_SKIP_MICROSITE }, { text: MENU_BUTTONS.POST_CANCEL }]);
    return {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Pilih microsite'
    };
  }

  if (step === 'review') {
    return {
      keyboard: [
        [{ text: MENU_BUTTONS.POST_SEND }],
        [{ text: MENU_BUTTONS.POST_EDIT }, { text: MENU_BUTTONS.POST_CANCEL }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Cek preview lalu pilih aksi'
    };
  }

  if (step === 'edit_select') {
    return {
      keyboard: [
        [{ text: MENU_BUTTONS.POST_EDIT_DESCRIPTION }, { text: MENU_BUTTONS.POST_EDIT_PREVIEW }],
        [{ text: MENU_BUTTONS.POST_EDIT_CONTENT }],
        [{ text: MENU_BUTTONS.POST_EDIT_SHOP }, { text: MENU_BUTTONS.POST_EDIT_MICROSITE }],
        [{ text: MENU_BUTTONS.POST_BACK_REVIEW }, { text: MENU_BUTTONS.POST_CANCEL }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Pilih bagian edit'
    };
  }

  return {
    keyboard: draft && draft.editing ? [
      [{ text: MENU_BUTTONS.POST_BACK_REVIEW }, { text: MENU_BUTTONS.POST_CANCEL }]
    ] : [
      [{ text: MENU_BUTTONS.POST_CANCEL }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: step === 'content_link' ? 'Kirim link konten' : 'Kirim deskripsi'
  };
}

function postChannelSelectKeyboard() {
  const rows = getPostChannels().map((channel) => [{ text: channelButtonText(channel) }]);
  rows.push([{ text: MENU_BUTTONS.POST_CANCEL }]);

  return {
    keyboard: rows,
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Pilih channel tujuan'
  };
}

function postFromResultsKeyboard(results) {
  const buttons = results
    .map((result) => result && (result.newShareUrl || result.shortUrl))
    .filter(Boolean)
    .slice(0, 5)
    .map((link, index, list) => {
      const token = savePostActionLink(link);
      return [{
        text: list.length === 1 ? 'Langsung Post' : `Post Link ${index + 1}`,
        callback_data: `post_from_link:${token}`
      }];
    });

  return buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
}

function postFromPreviewKeyboard(previewUrl) {
  const token = savePostActionLink(previewUrl);
  return {
    inline_keyboard: [[{
      text: 'Langsung Post',
      callback_data: `post_from_preview:${token}`
    }]]
  };
}

function teraboxDashboardText(session) {
  return [
    'Dashboard TeraBox pribadi',
    '',
    session ? formatSessionSummary(session) : 'Status: belum terhubung',
    '',
    `${MENU_BUTTONS.TERABOX_LOGIN} - login QR lewat Puppeteer atau endpoint session`,
    `${MENU_BUTTONS.TERABOX_STATUS} - cek status session`,
    `${MENU_BUTTONS.TERABOX_DISCONNECT} - putus session lokal/endpoint`
  ].join('\n');
}

function teraboxDashboardKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BUTTONS.TERABOX_LOGIN }, { text: MENU_BUTTONS.TERABOX_STATUS }],
      [{ text: MENU_BUTTONS.TERABOX_DISCONNECT }],
      [{ text: MENU_BUTTONS.SHORTEN }, { text: MENU_BUTTONS.TERABOX_PRO }],
      [{ text: MENU_BUTTONS.TERABOX_CONVERT }],
      [{ text: MENU_BUTTONS.TERABOX_DASHBOARD }, { text: MENU_BUTTONS.HELP }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Kelola session TeraBox'
  };
}

function formatTeraboxSessionStart(payload, session) {
  const loginUrl = getPayloadString(payload, ['loginUrl', 'login_url', 'authorizeUrl', 'authorize_url']);
  const expiresAt = getPayloadString(payload, ['expiresAt', 'expires_at', 'expireAt', 'expire_at']) || session.expiresAt;
  const lines = [
    'Session TeraBox dimulai.',
    '',
    formatSessionSummary(session)
  ];

  if (loginUrl) {
    lines.push('', `Login URL: ${loginUrl}`);
  }

  if (expiresAt) {
    lines.push(`Berlaku sampai: ${expiresAt}`);
  }

  lines.push('', 'Setelah login selesai, pilih Status Session.');
  return lines.join('\n');
}

function formatTeraboxSessionStatus(session, note) {
  const lines = [
    'Status session TeraBox:',
    '',
    formatSessionSummary(session)
  ];

  if (note) {
    lines.push('', note);
  }

  return lines.join('\n');
}

function formatSessionSummary(session) {
  const lines = [
    `Status: ${session.status || 'unknown'}`,
    `Session ID: ${maskValue(session.sessionId)}`
  ];

  if (session.accountName) {
    lines.push(`Akun: ${session.accountName}`);
  }

  if (session.accountEmail) {
    lines.push(`Email: ${maskEmail(session.accountEmail)}`);
  }

  if (session.connectedAt) {
    lines.push(`Terhubung: ${session.connectedAt}`);
  }

  if (session.expiresAt) {
    lines.push(`Expired: ${session.expiresAt}`);
  }

  if (session.updatedAt) {
    lines.push(`Update: ${session.updatedAt}`);
  }

  return lines.join('\n');
}

async function ensureTeraboxDashboardAccess(message) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;

  if (!userId) {
    await reply(chatId, message.message_id, 'Dashboard TeraBox hanya tersedia untuk akun user, bukan channel.');
    return false;
  }

  if (!isPrivateChat(message)) {
    await reply(chatId, message.message_id, 'Dashboard TeraBox hanya bisa dibuka di chat private dengan bot.');
    return false;
  }

  if (!isAllowedDashboardUser(userId)) {
    await reply(chatId, message.message_id, 'Dashboard TeraBox dibatasi untuk user yang diizinkan.');
    return false;
  }

  return true;
}

async function ensurePrivateOwnerAccess(message, featureName) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;

  if (!userId) {
    await reply(chatId, message.message_id, `${featureName} hanya tersedia untuk akun user, bukan channel.`);
    return false;
  }

  if (!isPrivateChat(message)) {
    await reply(chatId, message.message_id, `${featureName} hanya bisa dibuka di chat private dengan bot.`);
    return false;
  }

  if (!isAllowedDashboardUser(userId)) {
    await reply(chatId, message.message_id, `${featureName} dibatasi untuk user yang diizinkan.`);
    return false;
  }

  return true;
}

function isPrivateChat(message) {
  return message.chat.type === 'private' || String(message.chat.id) === String(message.from && message.from.id);
}

function isAllowedDashboardUser(userId) {
  const id = String(userId);
  if (config.teraboxDashboardUserIds.size > 0) {
    return config.teraboxDashboardUserIds.has(id);
  }

  if (config.allowedUserIds.size > 0) {
    return config.allowedUserIds.has(id);
  }

  return true;
}

function isAllowedTarget(userId, chatId) {
  if (config.allowedUserIds.size === 0 && config.allowedChatIds.size === 0) {
    return true;
  }

  return (userId && config.allowedUserIds.has(String(userId))) || config.allowedChatIds.has(chatId);
}

function getPostDraftKey(message) {
  const userId = message.from && message.from.id;
  return userId ? `user:${userId}` : `chat:${message.chat.id}`;
}

function getPreviewDraftKey(message) {
  const userId = message.from && message.from.id;
  return userId ? `user:${userId}` : `chat:${message.chat.id}`;
}

function hasPreviewMedia(message) {
  return Boolean(getPreviewImageFromMessage(message));
}

function getPreviewImageFromMessage(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId: photo.file_id,
      filename: `${photo.file_unique_id || photo.file_id}.jpg`
    };
  }

  const document = message.document;
  if (document && /^image\//i.test(document.mime_type || '') && document.file_id) {
    return {
      fileId: document.file_id,
      filename: sanitizeFilename(document.file_name || `${document.file_unique_id || document.file_id}.jpg`)
    };
  }

  return null;
}

function isPostCancelText(text) {
  const normalized = text.trim().toLowerCase();
  return normalized === MENU_BUTTONS.POST_CANCEL.toLowerCase() || normalized === '/batal' || normalized === '/cancel';
}

function isPostBackReviewText(text) {
  return text.trim().toLowerCase() === MENU_BUTTONS.POST_BACK_REVIEW.toLowerCase();
}

function setDraftEditStep(draft, step, field) {
  return {
    ...draft,
    step,
    editing: field,
    updatedAt: new Date().toISOString()
  };
}

function clearDraftEdit(draft) {
  const next = {
    ...draft,
    updatedAt: new Date().toISOString()
  };
  delete next.editing;
  return next;
}

function savePostActionLink(link) {
  cleanupPostActionLinks();
  const token = crypto.randomBytes(8).toString('hex');
  postActionLinks.set(token, {
    link,
    expiresAt: Date.now() + 60 * 60 * 1000
  });
  return token;
}

function takePostActionLink(token) {
  cleanupPostActionLinks();
  const entry = postActionLinks.get(token);
  if (!entry) {
    return '';
  }

  postActionLinks.delete(token);
  return entry.link;
}

function cleanupPostActionLinks() {
  const now = Date.now();
  for (const [token, entry] of postActionLinks.entries()) {
    if (!entry || entry.expiresAt <= now) {
      postActionLinks.delete(token);
    }
  }
}

function parseAddChannelBody(body) {
  const clean = String(body || '').trim();
  const match = clean.match(/^(@[a-z0-9_]{5,}|-?\d{5,})(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  const id = match[1].trim();
  const name = normalizeChannelName(match[2] || id);
  return { id, name };
}

function parseRenameBody(body) {
  const clean = String(body || '').trim();
  const firstSpace = clean.search(/\s/);
  if (firstSpace === -1) {
    return null;
  }

  const query = clean.slice(0, firstSpace).trim();
  const name = clean.slice(firstSpace + 1).replace(/\s+/g, ' ').trim();
  if (!query || !name) {
    return null;
  }

  return { query, name };
}

async function ensureTelegraphAccount() {
  if (config.telegraphAccessToken) {
    return {
      access_token: config.telegraphAccessToken,
      short_name: config.telegraphShortName,
      author_name: config.telegraphAuthorName,
      author_url: config.telegraphAuthorUrl
    };
  }

  if (telegraphAccount && telegraphAccount.access_token) {
    return telegraphAccount;
  }

  telegraphAccount = await createTelegraphAccount({
    shortName: config.telegraphShortName,
    authorName: config.telegraphAuthorName,
    authorUrl: config.telegraphAuthorUrl
  });
  saveTelegraphAccountStore();
  return telegraphAccount;
}

function createPreviewTitle(now = new Date()) {
  return `ASUPAN ${formatDateForTitle(now, config.postTimeZone)}`;
}

function formatDateForTitle(date, timeZone) {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone,
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day} ${values.month} ${values.year}`;
}

function sanitizeFilename(value) {
  const clean = String(value || '').replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return clean || 'image.jpg';
}

async function validateBotChannelAdmin(channelId) {
  let chat;
  try {
    chat = await telegram('getChat', {
      chat_id: channelId
    });
  } catch (error) {
    throw new Error(`Bot tidak bisa membaca channel ${channelId}: ${error.message}`);
  }

  if (chat.type !== 'channel') {
    throw new Error(`Target ${channelId} bukan channel Telegram.`);
  }

  const bot = await getBotInfo();
  let member;
  try {
    member = await telegram('getChatMember', {
      chat_id: channelId,
      user_id: bot.id
    });
  } catch (error) {
    throw new Error(`Bot belum terdaftar di channel ${chat.title || channelId}: ${error.message}`);
  }

  const status = String(member.status || '').toLowerCase();
  if (status !== 'administrator' && status !== 'creator') {
    throw new Error(`Bot sudah ada di ${chat.title || channelId}, tapi statusnya ${status || 'unknown'}, bukan admin.`);
  }

  if (member.status === 'administrator' && member.can_post_messages === false) {
    throw new Error(`Bot admin di ${chat.title || channelId}, tapi belum punya izin post messages.`);
  }

  return {
    id: chat.id,
    title: chat.title || '',
    username: chat.username || '',
    status: member.status
  };
}

function parseAddLinkBody(body) {
  const clean = String(body || '').trim();
  const match = clean.match(/^(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+)(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  const url = normalizeUrl(stripTrailingPunctuation(match[1]));
  if (!url) {
    return null;
  }

  return {
    url,
    name: normalizeLinkName(match[2] || safeHost(url) || url)
  };
}

function upsertPostChannel(id, name) {
  const cleanId = String(id || '').trim();
  const channel = {
    id: cleanId,
    name: normalizeChannelName(name || cleanId),
    updatedAt: new Date().toISOString()
  };

  const existingIndex = postChannels.findIndex((item) => item.id === cleanId);
  if (existingIndex === -1) {
    channel.createdAt = channel.updatedAt;
    postChannels.push(channel);
  } else {
    channel.createdAt = postChannels[existingIndex].createdAt || channel.updatedAt;
    postChannels[existingIndex] = channel;
  }

  saveChannelStore();
  return channel;
}

function renamePostChannelRecord(query, name) {
  const index = findPostChannelIndex(query);
  if (index === -1) {
    return null;
  }

  postChannels[index] = {
    ...postChannels[index],
    name: normalizeChannelName(name),
    updatedAt: new Date().toISOString()
  };
  saveChannelStore();
  return postChannels[index];
}

function removePostChannel(query) {
  const index = findPostChannelIndex(query);
  if (index === -1) {
    return null;
  }

  const [removed] = postChannels.splice(index, 1);
  saveChannelStore();
  return removed;
}

function findPostChannelIndex(query) {
  const clean = String(query || '').trim();
  const indexNumber = Number.parseInt(clean, 10);
  let index = Number.isSafeInteger(indexNumber) && String(indexNumber) === clean ? indexNumber - 1 : -1;

  if (index < 0 || index >= postChannels.length) {
    const normalized = clean.toLowerCase();
    index = postChannels.findIndex((channel) => {
      return channel.id.toLowerCase() === normalized || channel.name.toLowerCase() === normalized;
    });
  }

  return index >= 0 && index < postChannels.length ? index : -1;
}

function getPostChannels() {
  return postChannels.slice();
}

function resolveSinglePostChannel() {
  const channels = getPostChannels();
  return channels[0] || null;
}

function findPostChannelByButtonText(text) {
  const normalized = String(text || '').trim();
  return getPostChannels().find((channel) => channelButtonText(channel) === normalized) || null;
}

function channelButtonText(channel) {
  return `Channel: ${channel.name}`;
}

function formatPostChannel(channel) {
  return `${channel.name} (${channel.id})`;
}

function normalizeChannelName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Channel';
}

function upsertPostLinkItem(type, url, name) {
  const items = getPostLinkStore(type);
  const cleanUrl = String(url || '').trim();
  const item = {
    url: cleanUrl,
    name: normalizeLinkName(name || cleanUrl),
    updatedAt: new Date().toISOString()
  };

  const existingIndex = items.findIndex((entry) => entry.url === cleanUrl);
  if (existingIndex === -1) {
    item.createdAt = item.updatedAt;
    items.push(item);
  } else {
    item.createdAt = items[existingIndex].createdAt || item.updatedAt;
    items[existingIndex] = item;
  }

  savePostLinkStore(type);
  return item;
}

function renamePostLinkRecord(type, query, name) {
  const items = getPostLinkStore(type);
  const index = findPostLinkIndex(type, query);
  if (index === -1) {
    return null;
  }

  items[index] = {
    ...items[index],
    name: normalizeLinkName(name),
    updatedAt: new Date().toISOString()
  };
  savePostLinkStore(type);
  return items[index];
}

function removePostLinkItem(type, query) {
  const items = getPostLinkStore(type);
  const index = findPostLinkIndex(type, query);
  if (index === -1) {
    return null;
  }

  const [removed] = items.splice(index, 1);
  savePostLinkStore(type);
  return removed;
}

function findPostLinkIndex(type, query) {
  const items = getPostLinkStore(type);
  const clean = String(query || '').trim();
  const indexNumber = Number.parseInt(clean, 10);
  let index = Number.isSafeInteger(indexNumber) && String(indexNumber) === clean ? indexNumber - 1 : -1;

  if (index < 0 || index >= items.length) {
    const normalized = clean.toLowerCase();
    index = items.findIndex((item) => item.url.toLowerCase() === normalized || item.name.toLowerCase() === normalized);
  }

  return index >= 0 && index < items.length ? index : -1;
}

function getPostLinkItems(type) {
  return getPostLinkStore(type).slice();
}

function getPostLinkStore(type) {
  return type === 'microsite' ? postMicrosites : postShops;
}

function findPostLinkItemByButtonText(text, type) {
  const normalized = String(text || '').trim();
  return getPostLinkItems(type).find((item) => postLinkButtonText(item, type) === normalized) || null;
}

function postLinkButtonText(item, type) {
  return `${postLinkTitle(type)}: ${item.name}`;
}

function formatPostLinkItem(item) {
  return `${item.name} (${item.url})`;
}

function normalizeLinkName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Link';
}

function postLinkLabel(type) {
  return type === 'microsite' ? 'microsite' : 'shop';
}

function postLinkTitle(type) {
  return type === 'microsite' ? 'Microsite' : 'Shop';
}

function postLinkAddCommand(type) {
  return type === 'microsite' ? '/addmicrosite' : '/addshop';
}

function postLinkListCommand(type) {
  return type === 'microsite' ? '/listmicrosite' : '/listshop';
}

function postLinkDeleteCommand(type) {
  return type === 'microsite' ? '/deletemicrosite' : '/deleteshop';
}

function postLinkRenameCommand(type) {
  return type === 'microsite' ? '/renamemicrosite' : '/renameshop';
}

function parseIdSet(value) {
  return new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function cleanHeaderName(value) {
  const clean = String(value || '').trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(clean)) {
    throw new Error('TERABOX_RESHARE_API_KEY_HEADER harus nama header HTTP yang valid.');
  }

  return clean;
}

function cleanTeraboxSharePassword(value) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }

  if (!/^[a-z0-9]{4}$/i.test(clean)) {
    throw new Error('TERABOX_CONVERT_SHARE_PASSWORD harus kosong atau 4 karakter alfanumerik.');
  }

  return clean;
}

function normalizeRemoteConfigDir(value) {
  const clean = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!clean || clean === '/') {
    return '/Tuna Bot';
  }

  return clean.startsWith('/') ? clean.replace(/\/$/g, '') : `/${clean.replace(/\/$/g, '')}`;
}

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DROPLINK_BASE_URL harus URL HTTP/HTTPS.');
  }

  url.pathname = url.pathname.replace(/\/+$/g, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/g, '');
}

function optionalUrl(value, name = 'URL') {
  const clean = value.trim();
  if (!clean) {
    return '';
  }

  let url;
  try {
    url = new URL(clean);
  } catch {
    throw new Error(`${name} harus URL HTTP/HTTPS yang valid.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} harus URL HTTP/HTTPS.`);
  }

  return url.toString();
}

function resolveWorkspacePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function loadSessionStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`[session-store] Gagal baca ${filePath}: ${error.message}`);
    return {};
  }
}

function loadTelegraphAccount(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.access_token ? parsed : null;
  } catch (error) {
    console.warn(`[telegraph-account] Gagal baca ${filePath}: ${error.message}`);
    return null;
  }
}

function loadChannelStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.channels) ? parsed.channels : [];
    return records
      .map((item) => ({
        id: String(item && item.id || '').trim(),
        name: normalizeChannelName(item && item.name || item && item.id || ''),
        createdAt: String(item && item.createdAt || ''),
        updatedAt: String(item && item.updatedAt || '')
      }))
      .filter((item) => item.id);
  } catch (error) {
    console.warn(`[channel-store] Gagal baca ${filePath}: ${error.message}`);
    return [];
  }
}

function loadLinkStore(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed[key]) ? parsed[key] : [];
    return records
      .map((item) => ({
        url: String(item && item.url || '').trim(),
        name: normalizeLinkName(item && item.name || item && item.url || ''),
        createdAt: String(item && item.createdAt || ''),
        updatedAt: String(item && item.updatedAt || '')
      }))
      .filter((item) => isHttpUrl(item.url));
  } catch (error) {
    console.warn(`[${key}-store] Gagal baca ${filePath}: ${error.message}`);
    return [];
  }
}

function saveSessionStore() {
  fs.mkdirSync(path.dirname(config.sessionStorePath), { recursive: true });
  const tempPath = `${config.sessionStorePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(teraboxSessions, null, 2));
  fs.renameSync(tempPath, config.sessionStorePath);
}

function saveTelegraphAccountStore() {
  fs.mkdirSync(path.dirname(config.telegraphAccountStorePath), { recursive: true });
  const tempPath = `${config.telegraphAccountStorePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(telegraphAccount || {}, null, 2));
  fs.renameSync(tempPath, config.telegraphAccountStorePath);
}

function saveChannelStore() {
  fs.mkdirSync(path.dirname(config.postChannelStorePath), { recursive: true });
  const tempPath = `${config.postChannelStorePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ channels: postChannels }, null, 2));
  fs.renameSync(tempPath, config.postChannelStorePath);
}

function savePostLinkStore(type) {
  const filePath = type === 'microsite' ? config.postMicrositeStorePath : config.postShopStorePath;
  const key = type === 'microsite' ? 'microsites' : 'shops';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ [key]: getPostLinkStore(type) }, null, 2));
  fs.renameSync(tempPath, filePath);
}

function getMessageUserSession(message) {
  if (!message.from || !message.from.id) {
    return null;
  }

  return getUserSession(message.from.id);
}

function getUserSession(userId) {
  return teraboxSessions[String(userId)] || null;
}

function setUserSession(userId, session) {
  teraboxSessions[String(userId)] = session;
  saveSessionStore();
}

function deleteUserSession(userId) {
  delete teraboxSessions[String(userId)];
  saveSessionStore();
}

function getPayloadString(payload, keys) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return '';
}

function maskValue(value) {
  const text = String(value || '');
  if (text.length <= 8) {
    return text || '-';
  }

  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function maskEmail(value) {
  const [name, domain] = String(value || '').split('@');
  if (!name || !domain) {
    return maskValue(value);
  }

  return `${name.slice(0, 2)}***@${domain}`;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function safeHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value, length = 180) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}...` : clean;
}

function truncateTelegramMessage(value, limit = 3900) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 24)}\n\n...dipotong oleh bot.` : text;
}

function pickStreamUrl(streams) {
  if (!streams || typeof streams !== 'object') {
    return '';
  }

  const preferredQualities = ['1080p', '720p', '480p', '360p'];
  for (const quality of preferredQualities) {
    if (typeof streams[quality] === 'string' && streams[quality]) {
      return streams[quality];
    }
  }

  const first = Object.values(streams).find((value) => typeof value === 'string' && value);
  return first || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop() {
  isStopping = true;
  console.log('Stopping bot...');
}
