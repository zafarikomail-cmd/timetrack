// ============================================================================
// Login page module
// ----------------------------------------------------------------------------
// Wires the real login form to Supabase Auth (email + password). No mock
// users, no bypass logic. Honors "Remember me" via the storage adapter
// configured in js/supabase.js, and redirects to the app shell on success.
// ============================================================================

import { supabase, isSupabaseConfigured, REMEMBER_ME_FLAG_KEY } from "./supabase.js";
import { getCurrentUser } from "./auth.js";

const APP_PAGE = "app.html";

const dom = {
  form: document.getElementById("loginForm"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  emailError: document.getElementById("emailError"),
  passwordError: document.getElementById("passwordError"),
  formAlert: document.getElementById("formAlert"),
  rememberMe: document.getElementById("rememberMe"),
  loginButton: document.getElementById("loginButton"),
  togglePassword: document.getElementById("togglePassword"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireTogglePassword();
  wireForm();

  // Already signed in? Skip straight to the app.
  const user = await getCurrentUser();
  if (user) window.location.replace(APP_PAGE);
}

function wireTogglePassword() {
  dom.togglePassword.addEventListener("click", () => {
    const isHidden = dom.password.type === "password";
    dom.password.type = isHidden ? "text" : "password";
    dom.togglePassword.setAttribute("aria-pressed", String(isHidden));
    dom.togglePassword.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    dom.togglePassword.querySelector(".icon-eye").hidden = isHidden;
    dom.togglePassword.querySelector(".icon-eye-off").hidden = !isHidden;
  });
}

function wireForm() {
  dom.email.addEventListener("input", () => setFieldError(dom.emailError, dom.email, ""));
  dom.password.addEventListener("input", () => setFieldError(dom.passwordError, dom.password, ""));

  dom.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideAlert();

    if (!isSupabaseConfigured) {
      showAlert("error", "Supabase isn't configured yet. Add your project URL and anon key to js/supabase.js.");
      return;
    }

    const email = dom.email.value.trim();
    const password = dom.password.value;
    let valid = true;

    if (!email) {
      setFieldError(dom.emailError, dom.email, "Email is required.");
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(dom.emailError, dom.email, "Enter a valid email address.");
      valid = false;
    }

    if (!password) {
      setFieldError(dom.passwordError, dom.password, "Password is required.");
      valid = false;
    }

    if (!valid) return;

    setLoading(true);

    // The remember-me flag must be set BEFORE signInWithPassword so the
    // storage adapter in supabase.js knows where to persist the session.
    localStorage.setItem(REMEMBER_ME_FLAG_KEY, String(dom.rememberMe.checked));

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setLoading(false);
      showAlert("error", mapAuthError(error));
      return;
    }

    showAlert("success", "Signed in — redirecting…");
    window.location.replace(APP_PAGE);
  });
}

function mapAuthError(error) {
  const message = error.message || "";
  if (/invalid login credentials/i.test(message)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(message)) return "Please confirm your email address before signing in.";
  if (/rate limit/i.test(message)) return "Too many attempts. Please wait a moment and try again.";
  return message || "Sign-in failed. Please try again.";
}

function setFieldError(errorEl, inputEl, message) {
  errorEl.textContent = message;
  inputEl.setAttribute("aria-invalid", message ? "true" : "false");
}

function showAlert(type, message) {
  dom.formAlert.textContent = message;
  dom.formAlert.dataset.type = type;
  dom.formAlert.hidden = false;
}

function hideAlert() {
  dom.formAlert.hidden = true;
  dom.formAlert.textContent = "";
}

function setLoading(isLoading) {
  dom.loginButton.disabled = isLoading;
  dom.loginButton.classList.toggle("is-loading", isLoading);
  dom.loginButton.querySelector(".button-spinner").hidden = !isLoading;
  dom.loginButton.querySelector(".button-text").textContent = isLoading ? "Signing in…" : "Sign In";
}