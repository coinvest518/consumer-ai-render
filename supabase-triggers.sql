-- Create function to trigger automation when mail status changes
CREATE OR REPLACE FUNCTION trigger_mail_automation()
RETURNS TRIGGER AS $$
BEGIN
  -- When mail status changes to 'delivered'
  IF NEW.status = 'delivered' AND (OLD.status IS NULL OR OLD.status != 'delivered') THEN
    
    -- Add to automation queue for immediate processing
    INSERT INTO automation_queue (
      user_id,
      task_type,
      scheduled_for,
      related_id,
      related_type,
      metadata
    ) VALUES (
      NEW.user_id,
      'send_delivery_notification',
      NOW(),
      NEW.id,
      'certified_mail',
      jsonb_build_object(
        'tracking_number', NEW.tracking_number,
        'recipient', NEW.recipient,
        'date_delivered', NEW.date_delivered
      )
    );
    
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on certified_mail table
DROP TRIGGER IF EXISTS mail_status_trigger ON certified_mail;
CREATE TRIGGER mail_status_trigger
  AFTER UPDATE ON certified_mail
  FOR EACH ROW
  EXECUTE FUNCTION trigger_mail_automation();

-- Create function to trigger when calendar events are due
CREATE OR REPLACE FUNCTION trigger_reminder_automation()
RETURNS TRIGGER AS $$
BEGIN
  -- When event is created and needs email reminder
  IF NEW.send_email_reminder = true AND NEW.email_sent = false THEN
    
    -- Schedule reminder for 24 hours before event
    INSERT INTO automation_queue (
      user_id,
      task_type,
      scheduled_for,
      related_id,
      related_type,
      metadata
    ) VALUES (
      NEW.user_id,
      'send_reminder_email',
      NEW.event_date - INTERVAL '24 hours',
      NEW.id,
      'calendar_event',
      jsonb_build_object(
        'event_title', NEW.title,
        'event_description', NEW.description,
        'event_date', NEW.event_date
      )
    );
    
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on calendar_events table
DROP TRIGGER IF EXISTS reminder_trigger ON calendar_events;
CREATE TRIGGER reminder_trigger
  AFTER INSERT ON calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION trigger_reminder_automation();

-- Create function to process automation queue
CREATE OR REPLACE FUNCTION process_automation_queue()
RETURNS TABLE (processed_count INTEGER) AS $$
DECLARE
  queue_item RECORD;
  processed INTEGER := 0;
BEGIN
  -- Get all pending tasks that are due
  FOR queue_item IN 
    SELECT * FROM automation_queue 
    WHERE status = 'pending' 
    AND scheduled_for <= NOW()
    ORDER BY scheduled_for ASC
    LIMIT 50
  LOOP
    
    -- Mark as processing
    UPDATE automation_queue 
    SET status = 'processing', last_attempt_at = NOW(), attempts = attempts + 1
    WHERE id = queue_item.id;
    
    -- Process based on task type
    IF queue_item.task_type = 'send_delivery_notification' THEN
      -- This will be handled by the API endpoint
      UPDATE automation_queue 
      SET status = 'ready_for_api'
      WHERE id = queue_item.id;
      processed := processed + 1;
      
    ELSIF queue_item.task_type = 'send_reminder_email' THEN
      -- This will be handled by the API endpoint  
      UPDATE automation_queue 
      SET status = 'ready_for_api'
      WHERE id = queue_item.id;
      processed := processed + 1;
      
    END IF;
    
  END LOOP;
  
  RETURN QUERY SELECT processed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;