import './globals.css';
export const metadata={title:'АлиДжон · Склад',description:'Общая база складского учёта трёх магазинов'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ru"><head><link rel="stylesheet" href="/style.css"/></head><body>{children}</body></html>}
