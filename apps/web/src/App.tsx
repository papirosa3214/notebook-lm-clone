import { BrowserRouter, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import NotebookPage from './pages/NotebookPage';
import SharedNotebookPage from './pages/SharedNotebookPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/notebooks/:id" element={<NotebookPage />} />
        <Route path="/shared/:token" element={<SharedNotebookPage />} />
      </Routes>
    </BrowserRouter>
  );
}
