import { Form, Input, Button, Card, message, Checkbox } from 'antd';
import { UserOutlined, LockOutlined, RightOutlined, AppstoreOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { useState, useEffect } from 'react';
import { createJSONStorage } from 'zustand/middleware';

export default function LoginPage() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await authApi.login(values);
      // Switch storage based on "remember me" choice
      const store = useAuthStore;
      const storageEngine = rememberMe ? localStorage : sessionStorage;
      // Update the persist storage dynamically before setting tokens
      store.persist.setOptions({
        storage: createJSONStorage(() => storageEngine),
      });
      store.getState().setToken(res.accessToken);
      if (res.refreshToken) {
        store.getState().setRefreshToken(res.refreshToken);
      }
      nav('/', { replace: true });
    } catch {
      message.error('用户名或密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      {/* 背景装饰 */}
      <div className="login-bg-decoration">
        <div className="bg-circle bg-circle-1"></div>
        <div className="bg-circle bg-circle-2"></div>
        <div className="bg-circle bg-circle-3"></div>
        <div className="bg-grid"></div>
      </div>

      {/* 登录卡片 */}
      <div className={`login-card-wrapper ${isVisible ? 'fade-in' : ''}`}>
        <Card className="login-card">
          {/* Logo 和标题区域 */}
          <div className="login-header">
            <div className="logo-wrapper">
              <div className="logo-icon">
                <AppstoreOutlined className="logo-svg" />
              </div>
            </div>
            <h1 className="login-title">AutoCodeFlow</h1>
            <p className="login-subtitle">企业级分布式任务调度系统</p>
          </div>

          {/* 登录表单 */}
          <Form onFinish={onFinish} size="large" className="login-form">
            <Form.Item
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <div className="form-field">
                <Input
                  prefix={<UserOutlined className="field-icon" />}
                  placeholder="用户名"
                  className="field-input"
                />
              </div>
            </Form.Item>

            <Form.Item
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <div className="form-field">
                <Input.Password
                  prefix={<LockOutlined className="field-icon" />}
                  placeholder="密码"
                  className="field-input"
                />
              </div>
            </Form.Item>

            <Form.Item style={{ marginBottom: 12 }}>
              <Checkbox
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              >
                <span style={{ color: '#666', fontSize: 13 }}>记住我</span>
              </Checkbox>
            </Form.Item>

            <Form.Item className="form-actions">
              <Button
                type="primary"
                htmlType="submit"
                block
                size="large"
                loading={loading}
                className="login-btn"
              >
                <span className="btn-text">登 录</span>
                <RightOutlined className="btn-icon" />
              </Button>
            </Form.Item>
          </Form>

          {/* 底部提示 */}
          <div className="login-footer">
            <p className="footer-text">
              默认账号：<span className="highlight">admin</span> 
              密码：<span className="highlight">admin123</span>
            </p>
          </div>
        </Card>

        {/* 版权信息 */}
        <p className="copyright">
          © 2026 AutoCodeFlow. All rights reserved.
        </p>
      </div>

      {/* 全局样式 */}
      <style>{`
        .login-container {
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
          position: relative;
          overflow: hidden;
        }

        .login-bg-decoration {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
        }

        .bg-circle {
          position: absolute;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(100px);
        }

        .bg-circle-1 {
          width: 500px;
          height: 500px;
          top: -100px;
          right: -100px;
          animation: float 6s ease-in-out infinite;
        }

        .bg-circle-2 {
          width: 400px;
          height: 400px;
          bottom: -150px;
          left: -100px;
          animation: float 8s ease-in-out infinite reverse;
        }

        .bg-circle-3 {
          width: 300px;
          height: 300px;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          animation: float 7s ease-in-out infinite 2s;
        }

        @keyframes float {
          0%, 100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-20px);
          }
        }

        .bg-grid {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-image: 
            linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
        }

        .login-card-wrapper {
          position: relative;
          z-index: 10;
          opacity: 0;
          transform: translateY(20px);
        }

        .login-card-wrapper.fade-in {
          animation: fadeInUp 0.6s ease-out forwards;
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .login-card {
          width: 420px;
          padding: 40px;
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(20px);
          border-radius: 20px;
          box-shadow: 
            0 25px 50px -12px rgba(0, 0, 0, 0.25),
            0 0 40px rgba(102, 126, 234, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .login-header {
          text-align: center;
          margin-bottom: 32px;
        }

        .logo-wrapper {
          display: flex;
          justify-content: center;
          margin-bottom: 16px;
        }

        .logo-icon {
          width: 64px;
          height: 64px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .logo-svg {
          font-size: 32px;
          color: white;
        }

        .login-title {
          font-size: 28px;
          font-weight: 700;
          color: #1a1a2e;
          margin: 0 0 8px 0;
          letter-spacing: -0.5px;
        }

        .login-subtitle {
          font-size: 14px;
          color: #888;
          margin: 0;
        }

        .login-form {
          margin-bottom: 16px;
        }

        .form-field {
          margin-bottom: 16px;
        }

        .field-icon {
          color: #999;
          font-size: 16px;
        }

        .field-input {
          height: 48px;
          border-radius: 12px;
          border: 1.5px solid #e0e0e0;
          transition: all 0.3s ease;
          background: #fafafa;
        }

        .field-input:focus {
          border-color: #667eea;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
          background: white;
        }

        .field-input::placeholder {
          color: #bbb;
        }

        .form-actions {
          margin-bottom: 0;
        }

        .login-btn {
          height: 50px;
          border-radius: 12px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border: none;
          font-size: 16px;
          font-weight: 600;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: all 0.3s ease;
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }

        .login-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
          background: linear-gradient(135deg, #768eea 0%, #865ba2 100%);
        }

        .login-btn:active {
          transform: translateY(0);
        }

        .btn-text {
          letter-spacing: 2px;
        }

        .btn-icon {
          font-size: 16px;
          transition: transform 0.3s ease;
        }

        .login-btn:hover .btn-icon {
          transform: translateX(4px);
        }

        .login-footer {
          text-align: center;
          padding-top: 16px;
          border-top: 1px solid #f0f0f0;
        }

        .footer-text {
          font-size: 13px;
          color: #999;
          margin: 0;
        }

        .highlight {
          color: #667eea;
          font-weight: 600;
        }

        .copyright {
          text-align: center;
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
          margin-top: 32px;
        }

        /* 响应式设计 */
        @media (max-width: 576px) {
          .login-card {
            width: 90%;
            padding: 30px 24px;
            margin: 0 16px;
          }

          .login-title {
            font-size: 24px;
          }

          .logo-icon {
            width: 56px;
            height: 56px;
          }

          .logo-svg {
            font-size: 28px;
          }
        }

        /* 深色模式适配 */
        @media (prefers-color-scheme: dark) {
          .login-card {
            background: rgba(30, 30, 50, 0.95);
            border-color: rgba(255, 255, 255, 0.1);
          }

          .login-title {
            color: #f0f0f0;
          }

          .login-subtitle {
            color: #aaa;
          }

          .field-input {
            background: rgba(255, 255, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.1);
            color: #f0f0f0;
          }

          .field-input:focus {
            background: rgba(255, 255, 255, 0.08);
          }

          .field-input::placeholder {
            color: #666;
          }

          .login-footer {
            border-top-color: rgba(255, 255, 255, 0.1);
          }

          .footer-text {
            color: #888;
          }
        }
      `}</style>
    </div>
  );
}
