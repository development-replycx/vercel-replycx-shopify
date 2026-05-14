// Credentials
const ADMIN_EMAIL = 'admin@reply.cx';
const ADMIN_PASSWORD = 'Admin@123';

document.addEventListener('DOMContentLoaded', () => {
    // Check if already logged in
    if (localStorage.getItem('isLoggedIn') === 'true') {
        window.location.href = 'index.html';
    }

    const loginForm = document.getElementById('login-form');
    const errorMsg = document.getElementById('error-msg');

    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
            localStorage.setItem('isLoggedIn', 'true');
            window.location.href = 'index.html';
        } else {
            errorMsg.style.display = 'block';
            // Shake effect could be added here
            setTimeout(() => {
                errorMsg.style.display = 'none';
            }, 5000);
        }
    });
});
