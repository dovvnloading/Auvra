
import React, { useState, useEffect, useRef } from 'react';
import * as Babel from '@babel/standalone';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface DynamicHUDComponentProps {
    code: string;
    [key: string]: any; // Allow passing standard props like size/opacity into the dynamic context
}

export const DynamicHUDComponent: React.FC<DynamicHUDComponentProps> = ({ code, ...props }) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [compiledCode, setCompiledCode] = useState<string | null>(null);

    // 1. Transpile Code (Main Thread - Safe AST transformation)
    // We transpile here to catch syntax errors early and send valid JS to the sandbox.
    useEffect(() => {
        if (!code) return;
        try {
            // Wrap in a named function component structure so Babel transforms it correctly
            // and we can easily instantiate it inside the sandbox.
            const sourceForBabel = `
                function GeneratedComponent(props) {
                    ${code}
                }
            `;
            
            const compiled = Babel.transform(sourceForBabel, { 
                presets: ['react'] 
            }).code;
            
            // Clean up "use strict" which Babel adds, as it can interfere with simple function evaluation
            setCompiledCode(compiled?.replace('"use strict";', '').trim() || null);
            setError(null);
        } catch (err: any) {
            let msg = err.message;
            if (msg.includes('return outside of function')) {
                msg = "Code error: Ensure 'return' is inside logic.";
            } else if (msg.includes('Adjacent JSX elements')) {
                msg = "JSX Error: Wrap elements in <></>.";
            }
            setError(msg);
        }
    }, [code]);

    // 2. Bridge: Send Code & Props to Sandbox
    useEffect(() => {
        const iframe = iframeRef.current;
        if (iframe && iframe.contentWindow && compiledCode) {
            iframe.contentWindow.postMessage({ 
                type: 'RENDER',
                code: compiledCode, 
                props: props 
            }, '*');
        }
    }, [compiledCode, props]);

    // 3. Sandbox Environment (SrcDoc)
    // This HTML runs in a restricted origin.
    const sandboxHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
                #root { width: 100%; height: 100%; display: flex; flex-direction: column; }
            </style>
            <script type="importmap">
            {
                "imports": {
                    "react": "https://esm.sh/react@18.2.0",
                    "react-dom/client": "https://esm.sh/react-dom@18.2.0/client?external=react"
                }
            }
            </script>
        </head>
        <body>
            <div id="root"></div>
            <script type="module">
                import React from 'react';
                import { createRoot } from 'react-dom/client';

                const rootElement = document.getElementById('root');
                const root = createRoot(rootElement);

                window.addEventListener('message', (event) => {
                    if (!event.data || event.data.type !== 'RENDER') return;

                    const { code, props } = event.data;

                    try {
                        // Create the component function from the transpiled string.
                        // 'React' is passed as an argument to the function constructor scope
                        // so the transpiled 'React.createElement' calls work.
                        const getComponent = new Function('React', 'return ' + code + ';');
                        const Component = getComponent(React);

                        // Render
                        root.render(React.createElement(Component, props));
                    } catch (err) {
                        root.render(
                            React.createElement('div', 
                                { style: { color: '#ef4444', fontSize: '10px', fontFamily: 'sans-serif', padding: '4px', backgroundColor: 'rgba(0,0,0,0.8)' } },
                                'Runtime Error: ' + err.message
                            )
                        );
                    }
                });
            </script>
        </body>
        </html>
    `;

    if (error) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center bg-red-900/20 border border-red-500/50 rounded p-2 text-center">
                <AlertTriangle size={24} className="text-red-500 mb-1" />
                <span className="text-[10px] text-red-300 font-mono break-all">{error}</span>
            </div>
        );
    }

    if (!compiledCode) {
        return (
            <div className="w-full h-full flex items-center justify-center text-gray-500">
                <Loader2 size={16} className="animate-spin" />
            </div>
        );
    }

    return (
        <iframe
            ref={iframeRef}
            srcDoc={sandboxHtml}
            // IMPORTANT: 'allow-scripts' enables JS. 
            // OMITTING 'allow-same-origin' puts this in an opaque origin (no access to parent cookies/storage).
            sandbox="allow-scripts"
            className="w-full h-full border-0 bg-transparent pointer-events-none"
            title="HUD Sandbox"
        />
    );
};
