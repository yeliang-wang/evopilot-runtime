import {createRoot} from 'react-dom/client';
import {App} from './App';
import './styles.css';
const container=document.getElementById('root');if(!container)throw Error('Dashboard root is missing');createRoot(container).render(<App/>);
