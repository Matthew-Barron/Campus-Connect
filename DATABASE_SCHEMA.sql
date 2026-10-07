/**
 * Campus Connect Database Schema
 * A verified-student platform for marketplace, events, polls, societies, and tutoring
 * 
 * Database: campus_connect
 * Version: 1.0
 * Author: Matthew (SQL Developer)
 * Date: October 5, 2026
 */

-- ============================================================================
-- DATABASE CREATION & CONFIGURATION
-- ============================================================================

CREATE DATABASE IF NOT EXISTS campus_connect;
USE campus_connect;

-- Set to UTF8MB4 for full Unicode support
ALTER DATABASE campus_connect CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ============================================================================
-- CORE USERS TABLE
-- ============================================================================

CREATE TABLE Users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(120) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    student_number VARCHAR(20) NOT NULL UNIQUE,
    role ENUM('Student', 'Society_Admin', 'Staff') DEFAULT 'Student',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    reset_token VARCHAR(255) NULL,
    reset_token_expiry DATETIME NULL,
    is_active BOOLEAN DEFAULT TRUE,
    
    INDEX idx_email (email),
    INDEX idx_student_number (student_number),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- MARKETPLACE: LISTINGS & RESPONSES
-- ============================================================================

CREATE TABLE Listings (
    listing_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL CHECK (price > 0),
    status ENUM('Available', 'Sold', 'Pending') DEFAULT 'Available',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE Listing_Responses (
    response_id INT AUTO_INCREMENT PRIMARY KEY,
    listing_id INT NOT NULL,
    responder_id INT NOT NULL,
    message VARCHAR(500) NOT NULL CHECK (CHAR_LENGTH(message) >= 1 AND CHAR_LENGTH(message) <= 500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (listing_id) REFERENCES Listings(listing_id) ON DELETE CASCADE,
    FOREIGN KEY (responder_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_listing_id (listing_id),
    INDEX idx_responder_id (responder_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- EVENTS & RSVP
-- ============================================================================

CREATE TABLE Events (
    event_id INT AUTO_INCREMENT PRIMARY KEY,
    organiser_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    date_time DATETIME NOT NULL,
    location VARCHAR(200),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (organiser_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_organiser_id (organiser_id),
    INDEX idx_date_time (date_time),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE Event_RSVPs (
    event_id INT NOT NULL,
    user_id INT NOT NULL,
    rsvp_status ENUM('Attending', 'Not_Attending', 'Interested') DEFAULT 'Interested',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    PRIMARY KEY (event_id, user_id),
    FOREIGN KEY (event_id) REFERENCES Events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_rsvp_status (rsvp_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- POLLS & VOTING
-- ============================================================================

CREATE TABLE Polls (
    poll_id INT AUTO_INCREMENT PRIMARY KEY,
    created_by INT NOT NULL,
    question VARCHAR(255) NOT NULL,
    options JSON NOT NULL, -- Stored as JSON array: ["Option 1", "Option 2", "Option 3"]
    closes_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (created_by) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_created_by (created_by),
    INDEX idx_closes_at (closes_at),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE Poll_Votes (
    poll_id INT NOT NULL,
    user_id INT NOT NULL,
    selected_option VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (poll_id, user_id),
    FOREIGN KEY (poll_id) REFERENCES Polls(poll_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- SOCIETIES & MEMBERSHIP
-- ============================================================================

CREATE TABLE Societies (
    society_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    admin_user_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (admin_user_id) REFERENCES Users(user_id) ON DELETE SET NULL,
    INDEX idx_admin_user_id (admin_user_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE Society_Members (
    society_id INT NOT NULL,
    user_id INT NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (society_id, user_id),
    FOREIGN KEY (society_id) REFERENCES Societies(society_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_joined_at (joined_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TUTORING LISTINGS
-- ============================================================================

CREATE TABLE Tutoring_Listings (
    tutoring_id INT AUTO_INCREMENT PRIMARY KEY,
    tutor_id INT NOT NULL,
    subject VARCHAR(100) NOT NULL,
    rate DECIMAL(10, 2) NOT NULL CHECK (rate > 0),
    availability VARCHAR(200),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (tutor_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    INDEX idx_tutor_id (tutor_id),
    INDEX idx_subject (subject),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================

CREATE TABLE Notifications (
    notification_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type ENUM('Event', 'Poll', 'Listing', 'Society', 'System') DEFAULT 'System',
    message VARCHAR(500) NOT NULL,
    related_event_id INT NULL,
    related_poll_id INT NULL,
    related_listing_id INT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (related_event_id) REFERENCES Events(event_id) ON DELETE SET NULL,
    FOREIGN KEY (related_poll_id) REFERENCES Polls(poll_id) ON DELETE SET NULL,
    FOREIGN KEY (related_listing_id) REFERENCES Listings(listing_id) ON DELETE SET NULL,
    INDEX idx_user_id (user_id),
    INDEX idx_is_read (is_read),
    INDEX idx_type (type),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View: Unread notification count per user
CREATE VIEW vw_unread_notifications AS
SELECT 
    user_id,
    COUNT(*) as unread_count
FROM Notifications
WHERE is_read = FALSE
GROUP BY user_id;

-- View: Active polls (not yet closed)
CREATE VIEW vw_active_polls AS
SELECT 
    poll_id,
    question,
    created_by,
    options,
    closes_at,
    (SELECT COUNT(*) FROM Poll_Votes WHERE poll_id = Polls.poll_id) as vote_count,
    CASE WHEN closes_at > NOW() THEN 1 ELSE 0 END as is_active
FROM Polls
WHERE closes_at > NOW();

-- View: Society member counts
CREATE VIEW vw_society_member_counts AS
SELECT 
    society_id,
    COUNT(*) as member_count
FROM Society_Members
GROUP BY society_id;

-- View: Event attendance
CREATE VIEW vw_event_attendance AS
SELECT 
    event_id,
    COUNT(CASE WHEN rsvp_status = 'Attending' THEN 1 END) as attending_count,
    COUNT(CASE WHEN rsvp_status = 'Interested' THEN 1 END) as interested_count,
    COUNT(CASE WHEN rsvp_status = 'Not_Attending' THEN 1 END) as not_attending_count,
    COUNT(*) as total_responses
FROM Event_RSVPs
GROUP BY event_id;

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Composite indexes for common queries
CREATE INDEX idx_listings_user_status ON Listings(user_id, status);
CREATE INDEX idx_events_organiser_date ON Events(organiser_id, date_time);
CREATE INDEX idx_poll_votes_poll_user ON Poll_Votes(poll_id, user_id);
CREATE INDEX idx_notifications_user_read ON Notifications(user_id, is_read);

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================

