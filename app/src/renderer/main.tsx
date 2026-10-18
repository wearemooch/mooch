import { IconContext } from '@phosphor-icons/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './monaco';
import { App } from './App';
import { useApp } from './store';
import { applyTheme } from './theme';
import './styles.css';

// Apply the saved theme before the first paint, so a Day user never sees a flash of Night.
void useApp
  .getState()
  .loadSettings()
  .catch(() => undefined)
  .finally(() => {
    applyTheme();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        {/* Brand book: Phosphor Regular at 16px in the chrome; dense rows pass 14. */}
        <IconContext.Provider value={{ size: 16, weight: 'regular' }}>
          <App />
        </IconContext.Provider>
      </StrictMode>,
    );
  });
