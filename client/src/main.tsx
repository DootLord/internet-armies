import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// No StrictMode: the engine owns a WebGL context and a rAF loop; double-mounting
// in dev would create and tear down a context on every load.
createRoot(document.getElementById('root')!).render(<App />);
