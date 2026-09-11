import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';

export default function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Result
        status="404"
        title={t('notFound.title')}
        subTitle={t('notFound.subTitle')}
        extra={
          <Button type="primary" onClick={() => navigate('/', { replace: true })}>
            {t('notFound.backHome')}
          </Button>
        }
      />
    </div>
  );
}
