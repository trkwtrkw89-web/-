// إعدادات الاتصال بـ Supabase — مشروع عصفور
const SUPABASE_URL = 'https://brefhjuhlwdvjnrtouvp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJyZWZoanVobHdkdmpucnRvdXZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MjgxNjgsImV4cCI6MjEwNDIwNDE2OH0.VkDdEufkOxQM9JURpblMsPWDyJ8LT8ZwhGBLKjDzjG4';

// Fake email domain trick: Supabase Auth requires an email, but Asfour only
// asks users for a username. We map username -> `${username}@asfour.local`
// internally so the login UX stays "username + password" only.
const FAKE_EMAIL_DOMAIN = '@asfour.local';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
