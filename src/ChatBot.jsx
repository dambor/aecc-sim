import React, { useState, useEffect, useRef } from 'react';

const ChatBot = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [isMaximized, setIsMaximized] = useState(false);
    const [messages, setMessages] = useState([
        { text: "Tactical Advisor Online. Systems Ready.", isAi: true }
    ]);
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef(null);
    const sessionIdRef = useRef(crypto.randomUUID());

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSend = async () => {
        if (!inputValue.trim() || isLoading) return;

        const userMsg = inputValue.trim();
        setMessages(prev => [...prev, { text: userMsg, isAi: false }]);
        setInputValue("");
        setIsLoading(true);
        
        // Use environment variable to secure the API key
        const apiKey = import.meta.env.VITE_LANGFLOW_API_KEY;
        const payload = {
            "output_type": "chat",
            "input_type": "chat",
            "input_value": userMsg,
            "session_id": sessionIdRef.current,
            "tweaks": {}
        };

        try {
            const response = await fetch("http://localhost:7860/api/v1/run/604fddf2-a7af-44f9-a8ef-ee5052ff89b7", {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "x-api-key": apiKey
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            const aiText = data.outputs?.[0]?.outputs?.[0]?.results?.message?.text || 
                           data.outputs?.[0]?.outputs?.[0]?.messages?.[0]?.message ||
                           "Unable to parse tactical intelligence. Try again.";

            setMessages(prev => [...prev, { text: aiText, isAi: true }]);
        } catch (error) {
            console.error("Chat Error:", error);
            setMessages(prev => [...prev, { text: "Connection failed. Check Langflow server status.", isAi: true }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter') handleSend();
    };

    // Simple Regex-based Markdown formatter
    const formatMessage = (text) => {
        if (!text) return "";
        
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
            .replace(/^\s*-\s+(.*)/gm, '<li>$1</li>')         // Lists
            .split('\n').map((line, i) => (
                <span key={i}>
                    {line.startsWith('<li>') ? 
                        <ul style={{margin: '5px 0', paddingLeft: '20px'}} dangerouslySetInnerHTML={{__html: line}}></ul> : 
                        <span dangerouslySetInnerHTML={{__html: line}}></span>
                    }
                    <br />
                </span>
            ));
    };

    return (
        <div className="tactical-chat-root">
            <style>
                {`
                    .tactical-chat-root {
                        --neon-blue: #00d4ff;
                        --dark-bg: rgba(7, 13, 26, 0.98);
                        --glass-border: rgba(0, 212, 255, 0.3);
                        --message-ai: rgba(22, 38, 70, 0.9);
                        --message-user: rgba(0, 100, 200, 0.9);
                    }

                    .chat-trigger {
                        position: fixed;
                        bottom: 20px;
                        right: 20px;
                        width: 60px;
                        height: 60px;
                        border-radius: 50%;
                        background: #3b82f6; /* Matching user's previous preference */
                        border: 2px solid white;
                        color: white;
                        font-size: 28px;
                        cursor: pointer;
                        z-index: 10005;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 4px 15px rgba(0,0,0,0.3);
                        transition: all 0.2s;
                    }

                    .chat-window {
                        position: fixed;
                        z-index: 10000;
                        background: var(--dark-bg);
                        backdrop-filter: blur(20px);
                        border: 1px solid var(--glass-border);
                        display: flex;
                        flex-direction: column;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        box-shadow: 0 12px 60px rgba(0,0,0,0.7);
                        overflow: hidden;
                    }

                    .chat-window.minimized {
                        width: 380px;
                        height: 550px;
                        bottom: 100px;
                        right: 25px;
                        border-radius: 12px;
                    }

                    .chat-window.maximized {
                        inset: 0;
                        width: 100vw;
                        height: 100vh;
                        border-radius: 0;
                    }

                    .chat-header {
                        height: 50px; /* Fixed height for consistency */
                        min-height: 50px;
                        padding: 0 20px;
                        background: rgba(0, 212, 255, 0.15);
                        border-bottom: 1px solid var(--glass-border);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        flex-shrink: 0;
                    }

                    .header-title {
                        font-family: 'Courier New', monospace;
                        font-size: 13px;
                        font-weight: bold;
                        color: var(--neon-blue);
                        letter-spacing: 2px;
                        display: flex;
                        align-items: center;
                    }

                    .chat-messages {
                        flex: 1;
                        padding: 20px;
                        overflow-y: auto;
                        display: flex;
                        flex-direction: column;
                        gap: 15px;
                    }

                    .message {
                        max-width: 90%;
                        padding: 12px 18px;
                        border-radius: 12px;
                        font-family: 'Inter', sans-serif;
                        font-size: 14px;
                        line-height: 1.6;
                        white-space: pre-wrap; /* Preserve line breaks */
                        word-wrap: break-word;
                    }

                    .message.ai {
                        align-self: flex-start;
                        background: var(--message-ai);
                        color: #e5eefc;
                        border: 1px solid rgba(0, 212, 255, 0.2);
                        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                    }

                    .message.user {
                        align-self: flex-end;
                        background: var(--message-user);
                        color: white;
                    }

                    .chat-input-area {
                        padding: 20px;
                        background: rgba(0,0,0,0.3);
                        border-top: 1px solid var(--glass-border);
                        display: flex;
                        gap: 10px;
                        flex-shrink: 0;
                    }

                    .chat-input {
                        flex: 1;
                        background: rgba(15, 23, 42, 0.9);
                        border: 1px solid var(--glass-border);
                        border-radius: 8px;
                        padding: 12px 16px;
                        color: white;
                        font-size: 14px;
                        outline: none;
                    }
                    .chat-input:focus { border-color: var(--neon-blue); box-shadow: 0 0 10px rgba(0, 212, 255, 0.2); }

                    .send-btn {
                        background: var(--neon-blue);
                        color: #0d1117;
                        border: none;
                        padding: 0 24px;
                        border-radius: 8px;
                        font-weight: bold;
                        cursor: pointer;
                        text-transform: uppercase;
                        letter-spacing: 1px;
                        font-size: 12px;
                    }

                    .control-btn {
                        background: rgba(255,255,255,0.05);
                        border: 1px solid rgba(255,255,255,0.1);
                        color: white;
                        padding: 4px 8px;
                        border-radius: 4px;
                        font-size: 10px;
                        cursor: pointer;
                        font-family: monospace;
                    }
                `}
            </style>

            <button className="chat-trigger" onClick={() => setIsOpen(!isOpen)}>
                {isOpen ? '✕' : '💬'}
            </button>

            {isOpen && (
                <div className={`chat-window ${isMaximized ? 'maximized' : 'minimized'}`}>
                    <div className="chat-header">
                        <div className="header-title">
                            <div className="status-pulse"></div>
                            TACTICAL ADVISOR
                        </div>
                        <button className="control-btn" onClick={() => setIsMaximized(!isMaximized)}>
                            {isMaximized ? "RESTORE" : "MAXIMIZE"}
                        </button>
                    </div>

                    <div className="chat-messages">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={`message ${msg.isAi ? 'ai' : 'user'}`}>
                                {msg.isAi ? formatMessage(msg.text) : msg.text}
                            </div>
                        ))}
                        {isLoading && (
                            <div className="message ai">...</div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    <div className="chat-input-area">
                        <input 
                            className="chat-input"
                            placeholder="Type command..."
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyPress={handleKeyPress}
                            disabled={isLoading}
                        />
                        <button className="send-btn" onClick={handleSend} disabled={isLoading}>
                            SEND
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ChatBot;
