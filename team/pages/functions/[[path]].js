// Cloudflare Pages dient nur dazu, team.apartments-strauss.de per CNAME bei goneo
// anzubinden. Jede Anfrage wird an den Worker „strauss-team“ weitergereicht
// (Service-Binding APP, einzurichten unter Pages → Einstellungen → Bindungen).
export const onRequest = ({ request, env }) => env.APP.fetch(request);
