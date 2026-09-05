let currentUser = null;
let currentView = 'timeline';
let currentSort = 'best';
let selectedMediaFile = null;
let unreadPollTimer = null;

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'الآن';
  if (diff < 3600) return `${Math.floor(diff/60)} د`;
  if (diff < 86400) return `${Math.floor(diff/3600)} س`;
  if (diff < 2592000) return `${Math.floor(diff/86400)} ي`;
  return new Date(iso).toLocaleDateString('ar');
}

function avatarHtml(user) {
  if (user && user.avatar_url) return `<img src="${user.avatar_url}" alt="">`;
  return `<div class="avatar-fallback">${escapeHtml(((user && user.display_name) || '?')[0])}</div>`;
}

function friendlyAuthError(err) {
  const msg = (err && err.message) || '';
  if (/already registered|already exists/i.test(msg)) return 'اسم المستخدم مستخدم من قبل';
  if (/password.*(least|short|weak)/i.test(msg)) return 'كلمة المرور قصيرة جداً (6 أحرف على الأقل)';
  if (/invalid login credentials/i.test(msg)) return 'بيانات الدخول غير صحيحة';
  return msg || 'حدث خطأ';
}

// ---------------- Supabase helpers ----------------
function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }));
}

async function uploadMedia(file, folder) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${folder}/${uuid()}.${ext}`;
  const { error } = await supabaseClient.storage.from('media').upload(path, file);
  if (error) throw new Error('فشل رفع الملف: ' + error.message);
  const { data } = supabaseClient.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}

async function notify(targetUserId, type, postId) {
  if (!targetUserId || targetUserId === currentUser.id) return;
  await supabaseClient.from('notifications').insert({
    user_id: targetUserId, actor_id: currentUser.id, type, post_id: postId || null
  });
}

// ---------------- Hydration (attach author/counts/viewer-state to raw rows) ----------------
async function hydratePosts(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const repostIds = [...new Set(rows.filter(r => r.repost_of).map(r => r.repost_of))];
  const replyToIds = [...new Set(rows.filter(r => r.reply_to).map(r => r.reply_to))];

  let originals = {};
  if (repostIds.length) {
    const { data } = await supabaseClient.from('posts').select('*, profiles(*)').in('id', repostIds);
    (data || []).forEach(o => originals[o.id] = o);
  }
  let parents = {};
  if (replyToIds.length) {
    const { data } = await supabaseClient.from('posts').select('id, profiles(username)').in('id', replyToIds);
    (data || []).forEach(p => parents[p.id] = p);
  }

  const allIds = [...new Set([...ids, ...repostIds])];
  const likeCounts = {}, replyCounts = {}, repostCounts = {};
  const likedSet = new Set(), repostedSet = new Set();

  if (allIds.length) {
    const { data: likeRows } = await supabaseClient.from('likes').select('post_id').in('post_id', allIds);
    (likeRows || []).forEach(l => likeCounts[l.post_id] = (likeCounts[l.post_id] || 0) + 1);

    const { data: replyRows } = await supabaseClient.from('posts').select('reply_to').in('reply_to', allIds);
    (replyRows || []).forEach(r => { if (r.reply_to) replyCounts[r.reply_to] = (replyCounts[r.reply_to] || 0) + 1; });

    const { data: repostRows } = await supabaseClient.from('posts').select('repost_of').in('repost_of', allIds);
    (repostRows || []).forEach(r => { if (r.repost_of) repostCounts[r.repost_of] = (repostCounts[r.repost_of] || 0) + 1; });

    if (currentUser) {
      const { data: myLikes } = await supabaseClient.from('likes').select('post_id').eq('user_id', currentUser.id).in('post_id', allIds);
      (myLikes || []).forEach(l => likedSet.add(l.post_id));
      const { data: myReposts } = await supabaseClient.from('posts').select('repost_of').eq('user_id', currentUser.id).in('repost_of', allIds);
      (myReposts || []).forEach(r => { if (r.repost_of) repostedSet.add(r.repost_of); });
    }
  }

  function build(row) {
    return {
      id: row.id,
      content: row.content,
      media_url: row.media_url,
      media_type: row.media_type,
      created_at: row.created_at,
      author: row.profiles,
      like_count: likeCounts[row.id] || 0,
      repost_count: repostCounts[row.id] || 0,
      reply_count: replyCounts[row.id] || 0,
      liked_by_viewer: likedSet.has(row.id),
      reposted_by_viewer: repostedSet.has(row.id),
      repost_of: row.repost_of ? buildOriginal(originals[row.repost_of]) : null,
      reply_to: row.reply_to && parents[row.reply_to] ? { id: row.reply_to, author: parents[row.reply_to].profiles } : null
    };
  }
  function buildOriginal(o) {
    if (!o) return null;
    return {
      id: o.id, content: o.content, media_url: o.media_url, media_type: o.media_type, created_at: o.created_at,
      author: o.profiles,
      like_count: likeCounts[o.id] || 0, repost_count: repostCounts[o.id] || 0, reply_count: replyCounts[o.id] || 0,
      liked_by_viewer: likedSet.has(o.id), reposted_by_viewer: repostedSet.has(o.id),
      repost_of: null, reply_to: null
    };
  }
  return rows.map(build);
}

function scorePost(p) {
  const ageHours = Math.max(0, (Date.now() - new Date(p.created_at).getTime()) / 3600000);
  const engagement = p.like_count * 1 + p.reply_count * 1.2 + p.repost_count * 1.5;
  return engagement / Math.pow(ageHours + 2, 1.8);
}
function rankPosts(posts) {
  return posts.slice().sort((a, b) => {
    const diff = scorePost(b) - scorePost(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

const SINCE_WINDOW = () => new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

async function fetchTimeline(sort) {
  const { data: followingRows } = await supabaseClient.from('follows').select('following_id').eq('follower_id', currentUser.id);
  const authorIds = [...new Set([currentUser.id, ...(followingRows || []).map(f => f.following_id)])];
  const { data, error } = await supabaseClient.from('posts').select('*, profiles(*)')
    .is('reply_to', null).in('user_id', authorIds).gte('created_at', SINCE_WINDOW())
    .order('created_at', { ascending: false }).limit(300);
  if (error) throw new Error(error.message);
  let hydrated = await hydratePosts(data || []);
  if (sort !== 'latest') hydrated = rankPosts(hydrated);
  return hydrated.slice(0, 50);
}

async function fetchExplore(sort) {
  const { data, error } = await supabaseClient.from('posts').select('*, profiles(*)')
    .is('reply_to', null).gte('created_at', SINCE_WINDOW())
    .order('created_at', { ascending: false }).limit(300);
  if (error) throw new Error(error.message);
  let hydrated = await hydratePosts(data || []);
  if (sort !== 'latest') hydrated = rankPosts(hydrated);
  return hydrated.slice(0, 50);
}

async function fetchThread(postId) {
  const { data: postRow, error } = await supabaseClient.from('posts').select('*, profiles(*)').eq('id', postId).single();
  if (error) throw new Error('المنشور غير موجود');
  const { data: replyRows } = await supabaseClient.from('posts').select('*, profiles(*)').eq('reply_to', postId).order('created_at', { ascending: true });
  const [post] = await hydratePosts([postRow]);
  const replies = await hydratePosts(replyRows || []);
  return { post, replies };
}

async function fetchProfilePage(username) {
  const { data: user, error } = await supabaseClient.from('profiles').select('*').eq('username', username).single();
  if (error) throw new Error('المستخدم غير موجود');
  const { count: followers } = await supabaseClient.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id);
  const { count: following } = await supabaseClient.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id);
  let isFollowing = false;
  if (currentUser && currentUser.id !== user.id) {
    const { data: f } = await supabaseClient.from('follows').select('follower_id').eq('follower_id', currentUser.id).eq('following_id', user.id).maybeSingle();
    isFollowing = !!f;
  }
  const { data: postRows } = await supabaseClient.from('posts').select('*, profiles(*)').eq('user_id', user.id).is('reply_to', null).order('created_at', { ascending: false }).limit(50);
  const posts = await hydratePosts(postRows || []);
  return { user, followers: followers || 0, following: following || 0, isFollowing, isSelf: currentUser && currentUser.id === user.id, posts };
}

async function searchAll(q) {
  const { data: users } = await supabaseClient.from('profiles').select('*').or(`username.ilike.%${q}%,display_name.ilike.%${q}%`).limit(20);
  const { data: postRows } = await supabaseClient.from('posts').select('*, profiles(*)').ilike('content', `%${q}%`).order('created_at', { ascending: false }).limit(30);
  const posts = await hydratePosts(postRows || []);
  return { users: users || [], posts };
}

async function fetchNotifications() {
  const { data, error } = await supabaseClient.from('notifications')
    .select('*, actor:profiles!notifications_actor_id_fkey(*), post:posts(id, content)')
    .eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}
async function markNotificationsRead() {
  await supabaseClient.from('notifications').update({ is_read: true }).eq('user_id', currentUser.id).eq('is_read', false);
}
async function fetchUnreadCount() {
  const { count } = await supabaseClient.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id).eq('is_read', false);
  return count || 0;
}

// ---------------- Auth ----------------
$$('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    $('#login-form').classList.toggle('hidden', which !== 'login');
    $('#register-form').classList.toggle('hidden', which !== 'register');
  });
});

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: username + FAKE_EMAIL_DOMAIN, password
    });
    if (error) throw error;
    const { data: profile, error: profErr } = await supabaseClient.from('profiles').select('*').eq('id', data.user.id).single();
    if (profErr) throw profErr;
    currentUser = profile;
    boot();
  } catch (err) { $('#login-error').textContent = friendlyAuthError(err); }
});

$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#reg-error').textContent = '';
  const displayName = $('#reg-display').value.trim();
  const username = $('#reg-username').value.trim();
  const password = $('#reg-password').value;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    $('#reg-error').textContent = 'اسم المستخدم يجب أن يكون بالإنجليزية (3-20 حرف/رقم/شرطة سفلية)';
    return;
  }
  try {
    const { data: existing } = await supabaseClient.from('profiles').select('id').eq('username', username).maybeSingle();
    if (existing) { $('#reg-error').textContent = 'اسم المستخدم مستخدم من قبل'; return; }

    const { data, error } = await supabaseClient.auth.signUp({
      email: username + FAKE_EMAIL_DOMAIN, password
    });
    if (error) throw error;
    if (!data.session) {
      $('#reg-error').textContent = 'يبدو أن تأكيد البريد مفعّل بإعدادات Supabase. عطّل "Confirm email" من Authentication settings وحاول من جديد.';
      return;
    }
    const { error: profErr } = await supabaseClient.from('profiles').insert({
      id: data.user.id, username, display_name: displayName
    });
    if (profErr) throw profErr;
    currentUser = { id: data.user.id, username, display_name: displayName, bio: '', avatar_url: '' };
    boot();
  } catch (err) { $('#reg-error').textContent = friendlyAuthError(err); }
});

async function tryRestoreSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return false;
  const { data: profile, error } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (error) return false;
  currentUser = profile;
  return true;
}

function boot() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderTopbarUser();
  renderComposerAvatar();
  switchTab('timeline');
  loadView('timeline');
  pollUnread();
  clearInterval(unreadPollTimer);
  unreadPollTimer = setInterval(pollUnread, 20000);
}

function renderTopbarUser() {
  $('#topbar-user').innerHTML = avatarHtml(currentUser);
  $('#topbar-user').onclick = () => { switchTab('profile'); loadView('profile'); };
}
function renderComposerAvatar() {
  $('#composer-avatar').innerHTML = avatarHtml(currentUser);
}

// ---------------- Tabs ----------------
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.view);
    loadView(tab.dataset.view);
  });
});
function switchTab(view) {
  currentView = view;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $('#composer').classList.toggle('hidden', view !== 'timeline');
  $('#sort-toggle').classList.toggle('hidden', view !== 'timeline' && view !== 'explore');
}

$$('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSort = btn.dataset.sort;
    $$('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    loadView(currentView);
  });
});

async function loadView(view) {
  const list = $('#posts-list');
  list.innerHTML = '<div class="empty-state">جارِ التحميل…</div>';
  try {
    if (view === 'timeline') {
      const posts = await fetchTimeline(currentSort);
      renderPosts(posts, list, 'لا توجد منشورات بعد — تابع أشخاصاً أو انشر أول تغريدة!');
    } else if (view === 'explore') {
      const posts = await fetchExplore(currentSort);
      renderPosts(posts, list, 'لا توجد منشورات في عصفور بعد.');
    } else if (view === 'notifications') {
      await loadNotifications();
    } else if (view === 'profile') {
      await loadProfile(currentUser.username);
    }
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderPosts(posts, container, emptyMsg) {
  if (!posts.length) {
    container.innerHTML = `<div class="empty-state"><span class="emoji">🐦</span>${emptyMsg}</div>`;
    return;
  }
  container.innerHTML = posts.map(postHtml).join('');
  attachPostHandlers(container);
}

function postHtml(p) {
  const display = p.repost_of ? p.repost_of : p;
  const repostLabel = p.repost_of ? `
    <div class="post-repost-label">
      <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
      أعاد ${escapeHtml(p.author.display_name)} النشر
    </div>` : '';
  const replyContext = display.reply_to ? `
    <div class="reply-context">رداً على <a href="#" data-user="${escapeHtml(display.reply_to.author.username)}">@${escapeHtml(display.reply_to.author.username)}</a></div>` : '';
  const media = display.media_url ? `
    <div class="post-media">
      ${display.media_type === 'video'
        ? `<video src="${display.media_url}" controls></video>`
        : `<img src="${display.media_url}" alt="">`}
    </div>` : '';
  return `
  <article class="post" data-id="${display.id}" data-author-id="${display.author.id}">
    <div class="post-avatar">${avatarHtml(display.author)}</div>
    <div class="post-main">
      ${repostLabel}
      <div class="post-header">
        <span class="name">${escapeHtml(display.author.display_name)}</span>
        <span class="username">@${escapeHtml(display.author.username)}</span>
        <span class="dot">·</span>
        <span class="time">${timeAgo(display.created_at)}</span>
      </div>
      ${replyContext}
      ${display.content ? `<div class="post-content">${escapeHtml(display.content)}</div>` : ''}
      ${media}
      <div class="post-actions">
        <button class="post-action reply-action">
          <svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M21 12c0 4.4-4 8-9 8-1.3 0-2.6-.2-3.7-.7L3 20l1.1-4.3C3.4 14.4 3 13.2 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"/></svg>
          <span>${display.reply_count || ''}</span>
        </button>
        <button class="post-action repost ${display.reposted_by_viewer ? 'active' : ''}">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
          <span>${display.repost_count || ''}</span>
        </button>
        <button class="post-action like ${display.liked_by_viewer ? 'active' : ''}">
          <svg viewBox="0 0 24 24"><path fill="${display.liked_by_viewer ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" d="M12 21s-7-4.5-9.5-9C.5 8 2 4 6 4c2.2 0 3.7 1.3 6 4 2.3-2.7 3.8-4 6-4 4 0 5.5 4 3.5 8-2.5 4.5-9.5 9-9.5 9z"/></svg>
          <span>${display.like_count || ''}</span>
        </button>
        ${display.author.id === currentUser.id ? `
        <button class="post-action delete">
          <svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg>
        </button>` : ''}
      </div>
    </div>
  </article>`;
}

function attachPostHandlers(container) {
  container.querySelectorAll('.post').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.post-action') || e.target.closest('[data-user]')) return;
      openThread(el.dataset.id);
    });
  });
  container.querySelectorAll('[data-user]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openProfileModal(el.dataset.user);
    });
  });
  container.querySelectorAll('.post-action.like').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const postEl = btn.closest('.post');
      const id = postEl.dataset.id, authorId = postEl.dataset.authorId;
      try {
        const { data: existing } = await supabaseClient.from('likes').select().eq('user_id', currentUser.id).eq('post_id', id).maybeSingle();
        let liked;
        if (existing) {
          await supabaseClient.from('likes').delete().eq('user_id', currentUser.id).eq('post_id', id);
          liked = false;
        } else {
          await supabaseClient.from('likes').insert({ user_id: currentUser.id, post_id: id });
          await notify(authorId, 'like', id);
          liked = true;
        }
        btn.classList.toggle('active', liked);
        const span = btn.querySelector('span');
        span.textContent = Math.max(0, (parseInt(span.textContent) || 0) + (liked ? 1 : -1)) || '';
      } catch (err) { toast(err.message); }
    });
  });
  container.querySelectorAll('.post-action.repost').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const postEl = btn.closest('.post');
      const id = postEl.dataset.id, authorId = postEl.dataset.authorId;
      try {
        const { data: existing } = await supabaseClient.from('posts').select('id').eq('user_id', currentUser.id).eq('repost_of', id).maybeSingle();
        let reposted;
        if (existing) {
          await supabaseClient.from('posts').delete().eq('id', existing.id);
          reposted = false;
        } else {
          await supabaseClient.from('posts').insert({ user_id: currentUser.id, content: '', repost_of: id });
          await notify(authorId, 'repost', id);
          reposted = true;
        }
        btn.classList.toggle('active', reposted);
        const span = btn.querySelector('span');
        span.textContent = Math.max(0, (parseInt(span.textContent) || 0) + (reposted ? 1 : -1)) || '';
        toast(reposted ? 'تمت إعادة النشر' : 'تم التراجع عن إعادة النشر');
      } catch (err) { toast(err.message); }
    });
  });
  container.querySelectorAll('.post-action.delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const postEl = btn.closest('.post');
      const id = postEl.dataset.id;
      if (!confirm('حذف هذا المنشور؟')) return;
      try {
        const { error } = await supabaseClient.from('posts').delete().eq('id', id).eq('user_id', currentUser.id);
        if (error) throw error;
        postEl.remove();
      } catch (err) { toast(err.message); }
    });
  });
}

// ---------------- Composer ----------------
$('#media-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedMediaFile = file;
  const url = URL.createObjectURL(file);
  const preview = $('#media-preview');
  preview.classList.remove('hidden');
  const isVideo = file.type.startsWith('video');
  preview.innerHTML = `
    ${isVideo ? `<video src="${url}" controls></video>` : `<img src="${url}">`}
    <button class="media-remove" id="remove-media">×</button>`;
  $('#remove-media').addEventListener('click', () => {
    selectedMediaFile = null;
    $('#media-input').value = '';
    preview.classList.add('hidden');
    preview.innerHTML = '';
  });
});

$('#post-btn').addEventListener('click', async () => {
  const text = $('#composer-text').value.trim();
  if (!text && !selectedMediaFile) return;
  const btn = $('#post-btn');
  btn.disabled = true;
  try {
    let media_url = null, media_type = null;
    if (selectedMediaFile) {
      media_url = await uploadMedia(selectedMediaFile, 'posts');
      media_type = selectedMediaFile.type.startsWith('video') ? 'video' : 'image';
    }
    const { error } = await supabaseClient.from('posts').insert({
      user_id: currentUser.id, content: text, media_url, media_type
    });
    if (error) throw error;
    $('#composer-text').value = '';
    selectedMediaFile = null;
    $('#media-input').value = '';
    $('#media-preview').classList.add('hidden');
    $('#media-preview').innerHTML = '';
    toast('تم النشر');
    if (currentView !== 'profile') switchTab('timeline');
    loadView(currentView === 'profile' ? 'timeline' : currentView);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- Profile ----------------
async function loadProfile(username) {
  const data = await fetchProfilePage(username);
  const list = $('#posts-list');
  const header = `
    <div class="profile-header">
      <div class="profile-cover"></div>
      <div class="profile-info">
        <div class="profile-avatar">${avatarHtml(data.user)}</div>
        <div class="profile-name-row">
          <div>
            <p class="profile-name">${escapeHtml(data.user.display_name)}</p>
            <p class="profile-username">@${escapeHtml(data.user.username)}</p>
          </div>
          ${data.isSelf
            ? `<button class="btn-outline" id="edit-profile-btn">تعديل الملف</button>`
            : `<button class="btn-outline ${data.isFollowing ? 'following' : ''}" id="follow-btn">${data.isFollowing ? 'متابَع' : 'متابعة'}</button>`}
        </div>
        ${data.user.bio ? `<p class="profile-bio">${escapeHtml(data.user.bio)}</p>` : ''}
        <div class="profile-stats">
          <span><b>${data.following}</b> يتابع</span>
          <span><b>${data.followers}</b> متابع</span>
        </div>
      </div>
    </div>
    <div id="profile-posts"></div>
  `;
  list.innerHTML = header;
  renderPosts(data.posts, $('#profile-posts'), 'لا توجد منشورات بعد.');

  if (data.isSelf) {
    $('#edit-profile-btn').addEventListener('click', () => openEditProfile(data.user));
  } else {
    $('#follow-btn').addEventListener('click', async (e) => {
      const btn = e.target;
      try {
        const { data: existing } = await supabaseClient.from('follows').select('follower_id').eq('follower_id', currentUser.id).eq('following_id', data.user.id).maybeSingle();
        let following;
        if (existing) {
          await supabaseClient.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', data.user.id);
          following = false;
        } else {
          await supabaseClient.from('follows').insert({ follower_id: currentUser.id, following_id: data.user.id });
          await notify(data.user.id, 'follow', null);
          following = true;
        }
        btn.textContent = following ? 'متابَع' : 'متابعة';
        btn.classList.toggle('following', following);
      } catch (err) { toast(err.message); }
    });
  }
}

function openEditProfile(user) {
  const panel = $('#modal-panel');
  panel.innerHTML = `
    <div class="modal-header"><button class="modal-close" id="close-modal">×</button><span>تعديل الملف الشخصي</span></div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
      <label>الاسم الظاهر<input type="text" id="edit-name" value="${escapeHtml(user.display_name)}" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:6px;margin-top:4px;"></label>
      <label>نبذة<textarea id="edit-bio" rows="3" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:6px;margin-top:4px;">${escapeHtml(user.bio || '')}</textarea></label>
      <label>الصورة الشخصية<input type="file" id="edit-avatar" accept="image/*" style="margin-top:4px;"></label>
      <button class="btn-primary" id="save-profile-btn">حفظ</button>
    </div>`;
  $('#post-modal').classList.remove('hidden');
  $('#close-modal').addEventListener('click', closeModal);
  $('#save-profile-btn').addEventListener('click', async () => {
    try {
      const avatarFile = $('#edit-avatar').files[0];
      if (avatarFile) {
        const url = await uploadMedia(avatarFile, 'avatars');
        await supabaseClient.from('profiles').update({ avatar_url: url }).eq('id', currentUser.id);
        currentUser.avatar_url = url;
      }
      const display_name = $('#edit-name').value.trim();
      const bio = $('#edit-bio').value.trim();
      const { error } = await supabaseClient.from('profiles').update({ display_name, bio }).eq('id', currentUser.id);
      if (error) throw error;
      currentUser.display_name = display_name;
      currentUser.bio = bio;
      closeModal();
      renderTopbarUser();
      renderComposerAvatar();
      loadView('profile');
      toast('تم الحفظ');
    } catch (err) { toast(err.message); }
  });
}

async function openProfileModal(username) {
  switchTab('profile');
  await loadProfile(username);
}

// ---------------- Thread / reply modal ----------------
async function openThread(postId) {
  const panel = $('#modal-panel');
  panel.innerHTML = '<div class="empty-state">جارِ التحميل…</div>';
  $('#post-modal').classList.remove('hidden');
  try {
    const data = await fetchThread(postId);
    panel.innerHTML = `
      <div class="modal-header"><button class="modal-close" id="close-modal">×</button><span>المنشور</span></div>
      <div id="thread-main">${postHtml(data.post)}</div>
      <div class="reply-box">
        <div class="post-avatar">${avatarHtml(currentUser)}</div>
        <textarea id="reply-text" placeholder="اكتب رداً..." rows="2"></textarea>
      </div>
      <div style="padding:0 16px 12px;text-align:left;">
        <button class="btn-primary small" id="send-reply">رد</button>
      </div>
      <div id="thread-replies"></div>
    `;
    attachPostHandlers($('#thread-main'));
    renderPosts(data.replies, $('#thread-replies'), 'لا توجد ردود بعد.');
    $('#close-modal').addEventListener('click', closeModal);
    $('#send-reply').addEventListener('click', async () => {
      const text = $('#reply-text').value.trim();
      if (!text) return;
      try {
        const { error } = await supabaseClient.from('posts').insert({
          user_id: currentUser.id, content: text, reply_to: postId
        });
        if (error) throw error;
        await notify(data.post.author.id, 'reply', postId);
        closeModal();
        loadView(currentView);
        toast('تم إرسال الرد');
      } catch (err) { toast(err.message); }
    });
  } catch (err) {
    panel.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function closeModal() {
  $('#post-modal').classList.add('hidden');
  $('#modal-panel').innerHTML = '';
}
$('#modal-backdrop').addEventListener('click', closeModal);

// ---------------- Notifications ----------------
const NOTIF_LABELS = {
  like: 'أعجب بمنشورك',
  repost: 'أعاد نشر منشورك',
  follow: 'بدأ بمتابعتك',
  reply: 'رد على منشورك'
};
const NOTIF_ICONS = {
  like: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 21s-7-4.5-9.5-9C.5 8 2 4 6 4c2.2 0 3.7 1.3 6 4 2.3-2.7 3.8-4 6-4 4 0 5.5 4 3.5 8-2.5 4.5-9.5 9-9.5 9z"/></svg>',
  repost: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
  follow: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5z"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M21 12c0 4.4-4 8-9 8-1.3 0-2.6-.2-3.7-.7L3 20l1.1-4.3C3.4 14.4 3 13.2 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"/></svg>'
};

async function loadNotifications() {
  const list = $('#posts-list');
  try {
    const notifications = await fetchNotifications();
    if (!notifications.length) {
      list.innerHTML = `<div class="empty-state"><span class="emoji">🔔</span>لا توجد إشعارات بعد.</div>`;
    } else {
      list.innerHTML = notifications.map(n => `
        <div class="notif-item ${n.is_read ? '' : 'unread'}" data-username="${escapeHtml(n.actor.username)}">
          <div class="notif-icon ${n.type}">${NOTIF_ICONS[n.type] || ''}</div>
          <div>
            <div class="notif-text"><b>${escapeHtml(n.actor.display_name)}</b> ${NOTIF_LABELS[n.type] || ''}</div>
            ${n.post && n.post.content ? `<div class="notif-time" style="color:var(--ink-soft);">${escapeHtml(n.post.content.slice(0,80))}</div>` : ''}
            <div class="notif-time">${timeAgo(n.created_at)}</div>
          </div>
        </div>`).join('');
      list.querySelectorAll('.notif-item').forEach(el => {
        el.addEventListener('click', () => openProfileModal(el.dataset.username));
      });
    }
    await markNotificationsRead();
    updateNotifBadge(0);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function updateNotifBadge(count) {
  const badge = $('#notif-badge');
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function pollUnread() {
  try {
    const count = await fetchUnreadCount();
    if (currentView !== 'notifications') updateNotifBadge(count);
  } catch (e) {}
}

// ---------------- Search ----------------
let searchTimer;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) return;
  searchTimer = setTimeout(async () => {
    try {
      const data = await searchAll(q);
      const list = $('#posts-list');
      $('#composer').classList.add('hidden');
      $('#sort-toggle').classList.add('hidden');
      $$('.tab').forEach(t => t.classList.remove('active'));
      let html = '';
      if (data.users.length) {
        html += `<div style="padding:10px 16px;font-weight:700;font-size:13px;color:var(--ink-soft);">أشخاص</div>`;
        html += data.users.map(u => `
          <div class="post" data-user="${escapeHtml(u.username)}" style="cursor:pointer;">
            <div class="post-avatar">${avatarHtml(u)}</div>
            <div class="post-main">
              <div class="post-header"><span class="name">${escapeHtml(u.display_name)}</span></div>
              <div class="username">@${escapeHtml(u.username)}</div>
            </div>
          </div>`).join('');
      }
      if (data.posts.length) {
        html += `<div style="padding:10px 16px;font-weight:700;font-size:13px;color:var(--ink-soft);">منشورات</div>`;
        html += data.posts.map(postHtml).join('');
      }
      list.innerHTML = html || `<div class="empty-state">لا توجد نتائج لـ "${escapeHtml(q)}"</div>`;
      list.querySelectorAll('[data-user]').forEach(el => {
        el.addEventListener('click', () => openProfileModal(el.dataset.user));
      });
      attachPostHandlers(list);
    } catch (err) { toast(err.message); }
  }, 350);
});

// ---------------- Init ----------------
(async function init() {
  try {
    const ok = await tryRestoreSession();
    if (ok) {
      boot();
    } else {
      $('#auth-screen').classList.remove('hidden');
    }
  } catch (e) {
    $('#auth-screen').classList.remove('hidden');
  }
})();
