import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (id) => document.getElementById(id);

function setAuthUI(ok, statusText, userId) {
  $("authStatus").textContent = statusText;
  $("userId").textContent = userId ?? "-";
  const dot = $("authDot");
  dot.classList.remove("ok","bad");
  dot.classList.add(ok ? "ok" : "bad");
}

function setMsg(text, isErr=false){
  const el = $("msg");
  el.textContent = text || "";
  el.classList.toggle("err", !!isErr);
}

function nextUrl() {
  const u = new URL(location.href);
  const next = u.searchParams.get("next");
  return next ? `./${next}` : "./index.html";
}

async function refresh() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    setAuthUI(false, "AUTH ERROR", "-");
    setMsg(error.message, true);
    return null;
  }
  const user = data?.session?.user;
  if (user) {
    setAuthUI(true, "signed-in", user.email ?? user.id);
    return user;
  }
  setAuthUI(false, "signed-out", "-");
  return null;
}

async function signIn(email, password) {
  setMsg("");
  $("btnLogin").disabled = true;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  $("btnLogin").disabled = false;

  if (error) {
    setMsg(error.message, true);
    setAuthUI(false, "signed-out", "-");
    return;
  }

  setAuthUI(true, "signed-in", data.user?.email ?? data.user?.id);
  location.href = nextUrl();
}

async function signOut() {
  setMsg("");
  await supabase.auth.signOut();
  await refresh();
}

$("frm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  await signIn(email, password);
});
$("btnLogout").addEventListener("click", signOut);

// auto: if already logged in -> go next
(async function init(){
  const user = await refresh();
  if (user) location.href = nextUrl();
})();