import Script from 'next/script';
export default function Page(){return <><div id="app"><div className="empty">Загрузка склада…</div></div><dialog id="dialog" className="modal"><button className="close" id="close-dialog" aria-label="Закрыть">×</button><div id="form"/></dialog><div id="toast" role="status" aria-live="polite"/><Script src="/app.js" strategy="afterInteractive"/></>}
