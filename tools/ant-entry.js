import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Button, Switch, Select, Slider, Segmented, theme } from 'antd';

window.React = React;
window.ReactDOMClient = { createRoot };
window.antd = { ConfigProvider, Button, Switch, Select, Slider, Segmented, theme };
