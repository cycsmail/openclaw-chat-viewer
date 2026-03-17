const form = document.getElementById("loginForm");
const errorEl = document.getElementById("error");
const submitBtn = form.querySelector(".login-button");
const btnText = submitBtn.querySelector(".login-button-text");
const btnLoading = submitBtn.querySelector(".login-button-loading");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  submitBtn.disabled = true;
  btnText.hidden = true;
  btnLoading.hidden = false;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value
      })
    });
    const data = await res.json();
    if (data.ok) {
      location.href = "/";
    } else {
      errorEl.textContent = data.error || "Login failed";
    }
  } catch {
    errorEl.textContent = "Network error — check your connection";
  } finally {
    submitBtn.disabled = false;
    btnText.hidden = false;
    btnLoading.hidden = true;
  }
});

form.username.focus();
