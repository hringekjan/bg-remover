-- ============================================================================
-- Sales History Analytics Queries
--
-- Apache Iceberg table: pricing_intelligence_{stage}.sales_history
--
-- These queries are designed to run against the sales history data lake
-- via AWS Athena for pricing intelligence and analytics.
--
-- Prerequisites:
-- 1. Glue database created: pricing_intelligence_{stage}
-- 2. Iceberg table created: sales_history
-- 3. Sample data loaded into S3/Iceberg table
-- ============================================================================


-- ============================================================================
-- Query 1: Sales Volume by Category and Month
--
-- Purpose: Analyze sales patterns across product categories
-- Use Case: Identify seasonal trends, peak selling periods, category performance
-- Output Columns: category, year, month, sales_count, avg_price, median_price
-- ============================================================================
SELECT
    category,
    year,
    month,
    COUNT(*) as sales_count,
    ROUND(AVG(sold_price), 2) as avg_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.5), 2) as median_price,
    ROUND(MIN(sold_price), 2) as min_price,
    ROUND(MAX(sold_price), 2) as max_price,
    ROUND(STDDEV(sold_price), 2) as price_stddev
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
GROUP BY category, year, month
ORDER BY year, month, sales_count DESC;


-- ============================================================================
-- Query 2: Brand Performance Analysis with Seasonal Breakdown
--
-- Purpose: Analyze brand-level performance across seasons
-- Use Case: Identify top-performing brands, seasonal strength variations
-- Output Columns: brand, season, items_sold, avg_price, price_stddev
-- ============================================================================
SELECT
    brand,
    season,
    COUNT(*) as items_sold,
    ROUND(AVG(sold_price), 2) as avg_price,
    ROUND(STDDEV(sold_price), 2) as price_stddev,
    ROUND(MIN(sold_price), 2) as min_price,
    ROUND(MAX(sold_price), 2) as max_price,
    COUNT(DISTINCT category) as num_categories
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
GROUP BY brand, season
HAVING COUNT(*) >= 10
ORDER BY items_sold DESC, brand ASC;


-- ============================================================================
-- Query 3: Product Condition Impact on Pricing
--
-- Purpose: Analyze how product condition affects selling price
-- Use Case: Inform product listing pricing, identify condition premiums
-- Output Columns: condition, avg_price, count, price_distribution
-- ============================================================================
SELECT
    condition,
    COUNT(*) as items_sold,
    ROUND(AVG(sold_price), 2) as avg_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.25), 2) as q1_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.5), 2) as median_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.75), 2) as q3_price,
    ROUND(STDDEV(sold_price), 2) as price_stddev
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year >= 2024
GROUP BY condition
ORDER BY avg_price DESC;


-- ============================================================================
-- Query 4: Category-Brand Cross-Tab Analysis
--
-- Purpose: Identify top brands within each category
-- Use Case: Build category-specific brand strategies, pricing recommendations
-- Output Columns: category, brand, sales_count, avg_price
-- ============================================================================
SELECT
    category,
    brand,
    COUNT(*) as sales_count,
    ROUND(AVG(sold_price), 2) as avg_price,
    COUNT(DISTINCT source) as data_sources
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
GROUP BY category, brand
HAVING COUNT(*) >= 5
ORDER BY category ASC, sales_count DESC;


-- ============================================================================
-- Query 5: Data Source Comparison (SmartGo vs Carousel)
--
-- Purpose: Compare pricing patterns between data sources
-- Use Case: Validate data quality, identify source-specific trends
-- Output Columns: source, metric_type, count, avg_price, median_price
-- ============================================================================
SELECT
    source,
    category,
    COUNT(*) as items_sold,
    ROUND(AVG(sold_price), 2) as avg_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.5), 2) as median_price,
    ROUND(MIN(sold_price), 2) as min_price,
    ROUND(MAX(sold_price), 2) as max_price
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
GROUP BY source, category
ORDER BY source, items_sold DESC;


-- ============================================================================
-- Query 6: Monthly Sales Trend Analysis
--
-- Purpose: Track sales volume and pricing trends over time
-- Use Case: Identify growth patterns, seasonal peaks, pricing evolution
-- Output Columns: year_month, sales_count, avg_price, trend
-- ============================================================================
WITH monthly_stats AS (
    SELECT
        year,
        month,
        DATE(CONCAT(year, '-', LPAD(month, 2, '0'), '-01')) as month_start,
        COUNT(*) as sales_count,
        ROUND(AVG(sold_price), 2) as avg_price,
        ROUND(SUM(sold_price), 2) as total_revenue
    FROM pricing_intelligence_dev.sales_history
    WHERE tenant_id = 'carousel-labs'
        AND year >= 2023
    GROUP BY year, month
)
SELECT
    month_start,
    sales_count,
    avg_price,
    total_revenue,
    LAG(sales_count) OVER (ORDER BY month_start) as prev_month_count,
    LAG(avg_price) OVER (ORDER BY month_start) as prev_month_avg_price,
    ROUND(
        ((sales_count - LAG(sales_count) OVER (ORDER BY month_start))
         / LAG(sales_count) OVER (ORDER BY month_start) * 100),
        2
    ) as volume_growth_pct
FROM monthly_stats
ORDER BY month_start DESC;


-- ============================================================================
-- Query 7: High-Value Products and Revenue Concentration
--
-- Purpose: Identify top-value products and revenue concentration
-- Use Case: Inventory focus, high-margin product identification
-- Output Columns: product_id, category, brand, condition, avg_price, sales_count
-- ============================================================================
SELECT
    product_id,
    category,
    brand,
    condition,
    COUNT(*) as sales_count,
    ROUND(AVG(sold_price), 2) as avg_price,
    ROUND(SUM(sold_price), 2) as total_revenue
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND sold_price > (SELECT AVG(sold_price) FROM pricing_intelligence_dev.sales_history
                       WHERE tenant_id = 'carousel-labs' AND year = 2024)
GROUP BY product_id, category, brand, condition
ORDER BY total_revenue DESC
LIMIT 100;


-- ============================================================================
-- Query 8: Product Embedding Similarity Candidates
--
-- Purpose: Identify products with embeddings for similarity search
-- Use Case: Find products for embedding-based recommendations
-- Output Columns: product_id, category, brand, sold_date, embedding_available
-- ============================================================================
SELECT
    product_id,
    category,
    brand,
    condition,
    sold_date,
    CASE WHEN embedding IS NOT NULL THEN 'yes' ELSE 'no' END as has_embedding,
    CAST(CARDINALITY(embedding) AS INT) as embedding_dims,
    ROUND(AVG(sold_price), 2) as avg_price
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND embedding IS NOT NULL
GROUP BY
    product_id,
    category,
    brand,
    condition,
    sold_date,
    embedding
ORDER BY sold_date DESC
LIMIT 1000;


-- ============================================================================
-- Query 9: Partition Pruning Example
--
-- Purpose: Efficiently query specific time periods using partitions
-- Use Case: Monthly reconciliation, period-specific analysis
-- Optimization: Uses partition columns (year, month) for efficiency
-- ============================================================================
SELECT
    product_id,
    tenant_id,
    category,
    brand,
    condition,
    sold_price,
    sold_date,
    season,
    source
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND month IN (10, 11, 12)
    AND sold_price > 100
ORDER BY sold_date DESC
LIMIT 500;


-- ============================================================================
-- Query 10: Data Quality Check - Missing Values and Anomalies
--
-- Purpose: Monitor data quality and identify anomalies
-- Use Case: Data validation, quality assurance, issue identification
-- Output Columns: metric, count, percentage
-- ============================================================================
WITH total_records AS (
    SELECT COUNT(*) as total_count
    FROM pricing_intelligence_dev.sales_history
    WHERE tenant_id = 'carousel-labs'
        AND year = 2024
)
SELECT
    'Total Records' as metric,
    (SELECT total_count FROM total_records) as count,
    100.0 as percentage
FROM total_records
UNION ALL
SELECT
    'Missing product_id',
    COUNT(*),
    ROUND(COUNT(*) * 100.0 / (SELECT total_count FROM total_records), 2)
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND product_id IS NULL
UNION ALL
SELECT
    'Missing embedding',
    COUNT(*),
    ROUND(COUNT(*) * 100.0 / (SELECT total_count FROM total_records), 2)
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND embedding IS NULL
UNION ALL
SELECT
    'Price <= 0 (anomaly)',
    COUNT(*),
    ROUND(COUNT(*) * 100.0 / (SELECT total_count FROM total_records), 2)
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND sold_price <= 0
UNION ALL
SELECT
    'Missing sold_date',
    COUNT(*),
    ROUND(COUNT(*) * 100.0 / (SELECT total_count FROM total_records), 2)
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND sold_date IS NULL;


-- ============================================================================
-- Query 11: Price Distribution Analysis (Quartiles)
--
-- Purpose: Analyze price distribution across product categories
-- Use Case: Pricing strategy optimization, margin analysis
-- Output Columns: category, quartile_analysis, distribution_metrics
-- ============================================================================
SELECT
    category,
    COUNT(*) as total_items,
    ROUND(MIN(sold_price), 2) as min_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.25), 2) as q1_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.5), 2) as median_price,
    ROUND(PERCENTILE_APPROX(sold_price, 0.75), 2) as q3_price,
    ROUND(MAX(sold_price), 2) as max_price,
    ROUND(AVG(sold_price), 2) as mean_price,
    ROUND(STDDEV(sold_price), 2) as stddev_price,
    ROUND(
        (PERCENTILE_APPROX(sold_price, 0.75) - PERCENTILE_APPROX(sold_price, 0.25))
        / PERCENTILE_APPROX(sold_price, 0.5),
        2
    ) as interquartile_range_ratio
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
    AND sold_price > 0
GROUP BY category
ORDER BY median_price DESC;


-- ============================================================================
-- Query 12: Season Performance Comparison
--
-- Purpose: Compare performance across seasons (Q1, Q2, Q3, Q4)
-- Use Case: Seasonal strategy optimization, quarterly planning
-- Output Columns: season, metrics_by_category
-- ============================================================================
SELECT
    season,
    COUNT(*) as total_items,
    COUNT(DISTINCT category) as num_categories,
    COUNT(DISTINCT brand) as num_brands,
    ROUND(AVG(sold_price), 2) as avg_price,
    ROUND(SUM(sold_price), 2) as total_revenue,
    ROUND(AVG(sold_price) OVER (PARTITION BY season), 2) as season_avg_price
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
    AND year = 2024
GROUP BY season
ORDER BY
    CASE season
        WHEN 'Q1' THEN 1
        WHEN 'Q2' THEN 2
        WHEN 'Q3' THEN 3
        WHEN 'Q4' THEN 4
    END;


-- ============================================================================
-- Utility Queries for Table Management
-- ============================================================================

-- Show table structure and partition information
-- DESCRIBE FORMATTED pricing_intelligence_dev.sales_history;

-- Show recent partitions
-- SELECT year, month, COUNT(*) as record_count
-- FROM pricing_intelligence_dev.sales_history
-- GROUP BY year, month
-- ORDER BY year DESC, month DESC
-- LIMIT 12;

-- Show Iceberg metadata (version history, snapshots)
-- SELECT * FROM "pricing_intelligence_dev"."sales_history$history"
-- LIMIT 20;
