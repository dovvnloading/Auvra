import React from 'react';
import { createRoot } from 'react-dom/client';
import { IconGallery } from './components/UI/Icons/IconGallery';
import './styles.css';

// The icon catalogue: a page of the development server only, never part of a build.
const root = document.getElementById('root');
if (root) createRoot(root).render(<IconGallery />);
