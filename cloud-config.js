/* StayLog · Supabase connection

   Both values below are meant to be public. The URL names the project; the
   publishable key identifies the app without authorising anything. What can
   actually be read or written is decided entirely by the policies in
   supabase/setup.sql, which is why they can sit in a public repository.

   The SECRET key (sb_secret_… / service_role) bypasses every one of those
   policies. It must never appear in this file, this repository, or the app. */
window.STAYLOG_CLOUD = {
  url: 'https://fnpuswexdaeqebrordvv.supabase.co',
  publishableKey: 'sb_publishable_otiF0zEKxecVQh3SXvUdpQ_ZQb5VxnO',
  // Her login screen turns "sunitha" into "sunitha@staff.raayavasyam.invalid"
  staffEmailDomain: 'staff.raayavasyam.invalid',
};
